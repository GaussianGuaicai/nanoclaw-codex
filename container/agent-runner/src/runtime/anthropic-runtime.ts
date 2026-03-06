import fs from 'fs';
import path from 'path';
import { query } from '@anthropic-ai/claude-agent-sdk';

import { AgentRuntime, RunQueryInput, RunQueryResult, RuntimeHooks } from './types.js';

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>(r => { this.waiting = r; });
      this.waiting = null;
    }
  }
}

export class AnthropicRuntime implements AgentRuntime {
  constructor(
    private readonly hooks: RuntimeHooks,
    private readonly shouldClose: () => boolean,
    private readonly drainIpcInput: () => string[],
    private readonly ipcPollMs: number,
  ) {}

  async runQuery(input: RunQueryInput): Promise<RunQueryResult> {
    const { prompt, sessionId, mcpServerPath, containerInput, sdkEnv, resumeAt } = input;

    const stream = new MessageStream();
    stream.push(prompt);

    // Poll IPC for follow-up messages and _close sentinel during the query
    let ipcPolling = true;
    let closedDuringQuery = false;
    const pollIpcDuringQuery = () => {
      if (!ipcPolling) return;
      if (this.shouldClose()) {
        this.hooks.onLog('Close sentinel detected during query, ending stream');
        closedDuringQuery = true;
        stream.end();
        ipcPolling = false;
        return;
      }
      const messages = this.drainIpcInput();
      for (const text of messages) {
        this.hooks.onLog(`Piping IPC message into active query (${text.length} chars)`);
        stream.push(text);
      }
      setTimeout(pollIpcDuringQuery, this.ipcPollMs);
    };
    setTimeout(pollIpcDuringQuery, this.ipcPollMs);

    let newSessionId: string | undefined;
    let lastAssistantUuid: string | undefined;
    let messageCount = 0;
    let resultCount = 0;

    // Load global CLAUDE.md as additional system context (shared across all groups)
    const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
    let globalClaudeMd: string | undefined;
    if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
      globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
    }

    // Discover additional directories mounted at /workspace/extra/*
    // These are passed to the SDK so their CLAUDE.md files are loaded automatically
    const extraDirs: string[] = [];
    const extraBase = '/workspace/extra';
    if (fs.existsSync(extraBase)) {
      for (const entry of fs.readdirSync(extraBase)) {
        const fullPath = path.join(extraBase, entry);
        if (fs.statSync(fullPath).isDirectory()) {
          extraDirs.push(fullPath);
        }
      }
    }
    if (extraDirs.length > 0) {
      this.hooks.onLog(`Additional directories: ${extraDirs.join(', ')}`);
    }

    for await (const message of query({
      prompt: stream,
      options: {
        cwd: '/workspace/group',
        additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
        resume: sessionId,
        resumeSessionAt: resumeAt,
        systemPrompt: globalClaudeMd
          ? { type: 'preset' as const, preset: 'claude_code' as const, append: globalClaudeMd }
          : undefined,
        allowedTools: [
          'Bash',
          'Read', 'Write', 'Edit', 'Glob', 'Grep',
          'WebSearch', 'WebFetch',
          'Task', 'TaskOutput', 'TaskStop',
          'TeamCreate', 'TeamDelete', 'SendMessage',
          'TodoWrite', 'ToolSearch', 'Skill',
          'NotebookEdit',
          'mcp__nanoclaw__*',
        ],
        env: sdkEnv,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project', 'user'],
        mcpServers: {
          nanoclaw: {
            command: 'node',
            args: [mcpServerPath],
            env: {
              NANOCLAW_CHAT_JID: containerInput.chatJid,
              NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
              NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
            },
          },
        },
        hooks: {
          PreCompact: [{ hooks: [this.hooks.onPreCompact] }],
          PreToolUse: [{ matcher: 'Bash', hooks: [this.hooks.onPreToolUseBash] }],
        },
      },
    })) {
      messageCount++;
      const msgType = message.type === 'system' ? `system/${(message as { subtype?: string }).subtype}` : message.type;
      this.hooks.onLog(`[msg #${messageCount}] type=${msgType}`);

      if (message.type === 'assistant' && 'uuid' in message) {
        lastAssistantUuid = (message as { uuid: string }).uuid;
      }

      if (message.type === 'system' && message.subtype === 'init') {
        newSessionId = message.session_id;
        this.hooks.onLog(`Session initialized: ${newSessionId}`);
      }

      if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
        const tn = message as { task_id: string; status: string; summary: string };
        this.hooks.onLog(`Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`);
      }

      if (message.type === 'result') {
        resultCount++;
        const textResult = 'result' in message ? (message as { result?: string }).result : null;
        this.hooks.onLog(`Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`);
        this.hooks.onResult(textResult || null, newSessionId);
      }
    }

    ipcPolling = false;
    this.hooks.onLog(`Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`);
    return { newSessionId, lastAssistantUuid, closedDuringQuery };
  }
}
