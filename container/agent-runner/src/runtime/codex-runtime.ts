import fs from 'fs';
import path from 'path';

import {
  Codex,
  ThreadOptions,
  type CodexOptions,
  type ThreadEvent,
} from '@openai/codex-sdk';

import {
  AgentRuntime,
  RunQueryInput,
  RunQueryResult,
  RuntimeHooks,
} from './types.js';

const BLOCKED_ENV_VARS = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
]);

function parseBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

function getCodexThreadOptions(input: RunQueryInput): ThreadOptions {
  const { sdkEnv } = input;

  return {
    workingDirectory: '/workspace/group',
    additionalDirectories: fs.existsSync('/workspace/extra')
      ? ['/workspace/extra']
      : undefined,
    sandboxMode:
      (sdkEnv.NANOCLAW_CODEX_SANDBOX_MODE as ThreadOptions['sandboxMode']) ||
      'workspace-write',
    approvalPolicy:
      (sdkEnv.NANOCLAW_CODEX_APPROVAL_POLICY as ThreadOptions['approvalPolicy']) ||
      'never',
    networkAccessEnabled: parseBool(sdkEnv.NANOCLAW_CODEX_NETWORK_ACCESS, false),
    webSearchEnabled: parseBool(
      sdkEnv.NANOCLAW_CODEX_WEB_SEARCH_ENABLED,
      false,
    ),
    webSearchMode:
      (sdkEnv.NANOCLAW_CODEX_WEB_SEARCH_MODE as ThreadOptions['webSearchMode']) ||
      'disabled',
    model: sdkEnv.NANOCLAW_CODEX_MODEL,
    modelReasoningEffort:
      (sdkEnv.NANOCLAW_CODEX_REASONING_EFFORT as ThreadOptions['modelReasoningEffort']) ||
      undefined,
  };
}

function getCodexProcessEnv(
  sdkEnv: Record<string, string | undefined>,
): Record<string, string> {
  const allowedPrefix = ['NANOCLAW_', 'CODEX_', 'OPENAI_'];
  const passthroughKeys = new Set(['PATH', 'HOME', 'SHELL', 'TZ', 'LANG', 'LC_ALL']);

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(sdkEnv)) {
    if (!value) continue;
    if (BLOCKED_ENV_VARS.has(key)) continue;

    const allowByPrefix = allowedPrefix.some(prefix => key.startsWith(prefix));
    if (allowByPrefix || passthroughKeys.has(key)) {
      env[key] = value;
    }
  }

  return env;
}

function getCodexOptions(input: RunQueryInput): CodexOptions {
  const { sdkEnv, containerInput } = input;

  return {
    apiKey: sdkEnv.OPENAI_API_KEY,
    baseUrl: sdkEnv.OPENAI_BASE_URL,
    env: getCodexProcessEnv(sdkEnv),
    config: {
      mcp_servers: {
        nanoclaw: {
          command: 'node',
          args: [input.mcpServerPath],
          env: {
            NANOCLAW_CHAT_JID: containerInput.chatJid,
            NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
            NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
          },
        },
      },
    },
  };
}

function eventSummary(event: ThreadEvent): string | null {
  if (event.type === 'item.completed') {
    if (event.item.type === 'command_execution') {
      return `command completed: ${event.item.command} (status=${event.item.status})`;
    }
    if (event.item.type === 'mcp_tool_call') {
      return `mcp tool call completed: ${event.item.server}/${event.item.tool}`;
    }
  }
  if (event.type === 'turn.failed') {
    return `turn failed: ${event.error.message}`;
  }
  if (event.type === 'error') {
    return `stream error: ${event.message}`;
  }
  return null;
}

function archiveCodexTurn(prompt: string, response: string, threadId?: string): void {
  const conversationsDir = '/workspace/group/conversations';
  fs.mkdirSync(conversationsDir, { recursive: true });

  const date = new Date().toISOString().split('T')[0];
  const suffix = threadId ? `codex-${threadId}` : 'codex-session';
  const filename = `${date}-${suffix}.md`;
  const filePath = path.join(conversationsDir, filename);

  const now = new Date().toISOString();
  const content = [
    `# Codex turn archive (${now})`,
    '',
    '## User',
    '',
    prompt,
    '',
    '## Assistant',
    '',
    response || '(empty)',
    '',
  ].join('\n');

  fs.appendFileSync(filePath, content);
}

export class CodexRuntime implements AgentRuntime {
  constructor(private readonly hooks: RuntimeHooks) {}

  async runQuery(input: RunQueryInput): Promise<RunQueryResult> {
    const { prompt, sessionId, resumeAt } = input;

    if (resumeAt) {
      this.hooks.onLog(
        `Codex runtime ignores resumeAt cursor for now: ${resumeAt}`,
      );
    }

    if (!input.sdkEnv.OPENAI_API_KEY) {
      throw new Error(
        'OPENAI_API_KEY is required when NANOCLAW_AGENT_PROVIDER=codex',
      );
    }

    const codex = new Codex(getCodexOptions(input));
    const threadOptions = getCodexThreadOptions(input);
    const thread = sessionId
      ? codex.resumeThread(sessionId, threadOptions)
      : codex.startThread(threadOptions);

    let finalText = '';
    let newSessionId = thread.id || sessionId || undefined;

    const streamed = await thread.runStreamed(prompt);
    for await (const event of streamed.events) {
      if (event.type === 'thread.started') {
        newSessionId = event.thread_id;
      }

      if (event.type === 'item.completed' && event.item.type === 'agent_message') {
        finalText = event.item.text || finalText;
      }

      const summary = eventSummary(event);
      if (summary) {
        this.hooks.onLog(`[codex] ${summary}`);
      }
    }

    archiveCodexTurn(prompt, finalText, newSessionId);
    this.hooks.onResult(finalText || null, newSessionId || undefined);

    return {
      newSessionId: newSessionId || undefined,
      lastAssistantUuid: undefined,
      closedDuringQuery: false,
    };
  }
}
