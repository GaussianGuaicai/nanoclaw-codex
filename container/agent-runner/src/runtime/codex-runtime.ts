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
  RuntimeIpc,
  TurnUsage,
} from './types.js';
import { formatLocalDate, formatLocalIsoTimestamp } from './time.js';

type CodexConfigObject = NonNullable<CodexOptions['config']>;
type CodexJsonValue =
  | string
  | number
  | boolean
  | CodexJsonValue[]
  | CodexConfigObject;

function parseBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}

function deepMergeConfig(
  lowerPriority: CodexConfigObject,
  higherPriority: CodexConfigObject,
): CodexConfigObject {
  const result: CodexConfigObject = { ...lowerPriority };
  for (const [key, value] of Object.entries(higherPriority)) {
    const existing = result[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      result[key] = deepMergeConfig(
        existing as CodexConfigObject,
        value as CodexConfigObject,
      );
      continue;
    }
    result[key] = value as CodexJsonValue;
  }
  return result;
}

export function getCodexThreadOptions(input: RunQueryInput): ThreadOptions {
  const { sdkEnv, containerInput } = input;
  const runtimePaths = containerInput.runtimePaths;
  if (!runtimePaths) {
    throw new Error('Missing runtimePaths in worker input');
  }

  return {
    workingDirectory: runtimePaths.groupPath,
    additionalDirectories:
      runtimePaths.additionalDirectories.length > 0
        ? runtimePaths.additionalDirectories
        : undefined,
    sandboxMode:
      (sdkEnv.NANOCLAW_CODEX_SANDBOX_MODE as ThreadOptions['sandboxMode']) ||
      'workspace-write',
    approvalPolicy:
      (sdkEnv.NANOCLAW_CODEX_APPROVAL_POLICY as ThreadOptions['approvalPolicy']) ||
      'never',
    networkAccessEnabled: parseBool(sdkEnv.NANOCLAW_CODEX_NETWORK_ACCESS, true),
    webSearchEnabled: parseBool(
      sdkEnv.NANOCLAW_CODEX_WEB_SEARCH_ENABLED,
      false,
    ),
    webSearchMode:
      (sdkEnv.NANOCLAW_CODEX_WEB_SEARCH_MODE as ThreadOptions['webSearchMode']) ||
      'disabled',
    model: containerInput.agentConfig?.model || sdkEnv.NANOCLAW_CODEX_MODEL,
    modelReasoningEffort:
      (containerInput.agentConfig?.reasoningEffort as ThreadOptions['modelReasoningEffort']) ||
      (sdkEnv.NANOCLAW_CODEX_REASONING_EFFORT as ThreadOptions['modelReasoningEffort']) ||
      undefined,
  };
}

function loadSharedInstructions(files: string[]): string | undefined {
  const sections: string[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    const resolved = path.resolve(file);
    if (seen.has(resolved) || !fs.existsSync(resolved)) continue;
    seen.add(resolved);

    const content = fs.readFileSync(resolved, 'utf-8').trim();
    if (!content) continue;

    const label = path.relative(process.cwd(), resolved) || resolved;
    sections.push(`# Shared instructions from ${label}\n${content}`);
  }

  return sections.length > 0 ? sections.join('\n\n') : undefined;
}

function resolveHttpMcpBridgeLaunch(): { command: string; args: string[] } {
  const bridgeDist = path.join(
    process.cwd(),
    'container',
    'agent-runner',
    'dist',
    'http-mcp-bridge.js',
  );
  if (fs.existsSync(bridgeDist)) {
    return {
      command: process.execPath,
      args: [bridgeDist],
    };
  }

  const bridgeSrc = path.join(
    process.cwd(),
    'container',
    'agent-runner',
    'src',
    'http-mcp-bridge.ts',
  );
  const localTsx = path.join(process.cwd(), 'node_modules', '.bin', 'tsx');
  if (fs.existsSync(localTsx)) {
    return {
      command: localTsx,
      args: [bridgeSrc],
    };
  }

  return {
    command: 'npx',
    args: ['tsx', bridgeSrc],
  };
}

const MAX_EVENT_LOG_TEXT = 4000;

function truncateForLog(text: string, max = MAX_EVENT_LOG_TEXT): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n...[TRUNCATED]`;
}

function formatLogValue(value: unknown, max = MAX_EVENT_LOG_TEXT): string {
  if (typeof value === 'string') {
    return truncateForLog(value, max);
  }

  try {
    return truncateForLog(JSON.stringify(value, null, 2), max);
  } catch {
    return truncateForLog(String(value), max);
  }
}

function logBlock(label: string, value: unknown): string {
  const formatted = formatLogValue(value)
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
  return `${label}:\n${formatted}`;
}

export function mergeNoProxyHosts(
  existingValue: string | undefined,
  hosts: string[] | undefined,
): string | undefined {
  const normalizedHosts =
    hosts?.map((value) => value.trim()).filter((value) => value.length > 0) ||
    [];
  if (normalizedHosts.length === 0) {
    return existingValue;
  }

  const merged = new Set(
    (existingValue || '')
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );

  for (const host of normalizedHosts) {
    merged.add(host);
  }

  return Array.from(merged).join(',');
}

export function getCodexOptions(input: RunQueryInput): CodexOptions {
  const { sdkEnv, containerInput } = input;
  const runtimePaths = containerInput.runtimePaths;
  if (!runtimePaths) {
    throw new Error('Missing runtimePaths in worker input');
  }

  const skillsDir = path.join(process.cwd(), 'container', 'skills');
  const skillConfigs = fs.existsSync(skillsDir)
    ? fs
        .readdirSync(skillsDir)
        .map((entry) => path.join(skillsDir, entry))
        .filter((entry) => {
          try {
            return fs.statSync(entry).isDirectory();
          } catch {
            return false;
          }
        })
        .map((entry) => ({ path: entry, enabled: true }))
    : [];
  const sharedInstructions = loadSharedInstructions(
    runtimePaths.sharedInstructionFiles,
  );
  const bridgeLaunch = resolveHttpMcpBridgeLaunch();
  const bridgeNames = new Set(containerInput.remoteMcpBridgeNames || []);
  const remoteMcpServers = Object.fromEntries(
    Object.entries(containerInput.remoteMcpServers || {}).map(
      ([name, server]) => {
        if (!bridgeNames.has(name)) {
          return [name, server];
        }

        return [
          name,
          {
            command: bridgeLaunch.command,
            args: bridgeLaunch.args,
            env: {
              NANOCLAW_REMOTE_MCP_NAME: name,
              NANOCLAW_REMOTE_MCP_URL: server.url,
              NANOCLAW_REMOTE_MCP_HEADERS_JSON: JSON.stringify(
                server.headers || {},
              ),
            },
          },
        ];
      },
    ),
  );
  const mcpServers = {
    nanoclaw: {
      command: input.mcpServerCommand,
      args: input.mcpServerArgs,
      env: {
        NANOCLAW_CHAT_JID: containerInput.chatJid,
        NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
        NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
        NANOCLAW_IPC_PATH: runtimePaths.ipcPath,
      },
    },
    ...remoteMcpServers,
  };

  const baseConfig: CodexConfigObject = {
    mcp_servers: mcpServers,
    sandbox_workspace_write: {
      writable_roots: runtimePaths.writableRoots,
      network_access: parseBool(sdkEnv.NANOCLAW_CODEX_NETWORK_ACCESS, true),
    },
    ...(skillConfigs.length > 0
      ? {
          skills: {
            config: skillConfigs,
          },
        }
      : {}),
    ...(sharedInstructions
      ? {
          developer_instructions: sharedInstructions,
        }
      : {}),
  };
  const userConfig = isPlainObject(
    containerInput.agentConfig?.codexConfigOverrides,
  )
    ? (containerInput.agentConfig.codexConfigOverrides as CodexConfigObject)
    : {};

  return {
    ...(sdkEnv.OPENAI_API_KEY ? { apiKey: sdkEnv.OPENAI_API_KEY } : {}),
    baseUrl: sdkEnv.OPENAI_BASE_URL,
    config: deepMergeConfig(userConfig, baseConfig),
  };
}

export function eventSummary(event: ThreadEvent): string[] {
  if (event.type === 'thread.started') {
    return [`thread started: ${event.thread_id}`];
  }

  if (event.type === 'turn.started') {
    return ['turn started'];
  }

  if (event.type === 'turn.completed') {
    return [
      `turn completed: input=${event.usage.input_tokens}, cached=${event.usage.cached_input_tokens}, output=${event.usage.output_tokens}`,
    ];
  }

  if (event.type === 'turn.failed') {
    return [`turn failed: ${event.error.message}`];
  }

  if (event.type === 'error') {
    return [`stream error: ${event.message}`];
  }

  const phase =
    event.type === 'item.started'
      ? 'started'
      : event.type === 'item.updated'
        ? 'updated'
        : 'completed';

  switch (event.item.type) {
    case 'command_execution': {
      const suffix = [
        `status=${event.item.status}`,
        ...(event.item.exit_code != null
          ? [`exit=${event.item.exit_code}`]
          : []),
      ].join(', ');
      const lines = [`command ${phase}: ${event.item.command} (${suffix})`];
      if (
        event.item.aggregated_output.trim() &&
        event.type !== 'item.started'
      ) {
        lines.push(
          logBlock('command output', event.item.aggregated_output.trim()),
        );
      }
      return lines;
    }

    case 'mcp_tool_call': {
      const lines = [
        `mcp tool ${phase}: ${event.item.server}/${event.item.tool} (status=${event.item.status})`,
        logBlock('tool arguments', event.item.arguments),
      ];
      if (event.item.result) {
        lines.push(logBlock('tool result', event.item.result));
      }
      if (event.item.error?.message) {
        lines.push(`tool error: ${event.item.error.message}`);
      }
      return lines;
    }

    case 'file_change':
      return [
        `file change ${phase}: ${event.item.changes.length} file(s) (status=${event.item.status})`,
        logBlock('file changes', event.item.changes),
      ];

    case 'web_search':
      return [`web search ${phase}: ${event.item.query}`];

    case 'reasoning':
      return [
        `reasoning ${phase}`,
        logBlock('reasoning summary', event.item.text),
      ];

    case 'todo_list':
      return [
        `todo list ${phase}: ${event.item.items.length} item(s)`,
        logBlock('todo items', event.item.items),
      ];

    case 'error':
      return [`item error ${phase}: ${event.item.message}`];

    case 'agent_message':
      return [];
  }
}

export function isSuccessfulSendMessageCall(event: ThreadEvent): boolean {
  return (
    event.type === 'item.completed' &&
    event.item.type === 'mcp_tool_call' &&
    event.item.server === 'nanoclaw' &&
    event.item.tool === 'send_message' &&
    event.item.status === 'completed' &&
    !event.item.error
  );
}

export function resolveFinalAutoDeliveryResult(
  finalText: string,
  usedSendMessageTool: boolean,
): string | null {
  if (usedSendMessageTool) return null;
  return finalText || null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function archiveCodexTurn(
  prompt: string,
  response: string,
  groupPath: string,
  threadId?: string,
  taskSource?: string,
): void {
  const conversationsDir = path.join(groupPath, 'conversations');
  fs.mkdirSync(conversationsDir, { recursive: true });

  const date = formatLocalDate();
  const suffix = threadId ? `codex-${threadId}` : 'codex-session';
  const filename = `${date}-${suffix}.md`;
  const filePath = path.join(conversationsDir, filename);

  const now = formatLocalIsoTimestamp();
  const content =
    taskSource === 'websocket'
      ? [
          `# Codex turn archive (${now})`,
          '',
          '## WebSocket task',
          '',
          '(details omitted)',
          '',
        ].join('\n')
      : [
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
  constructor(
    private readonly hooks: RuntimeHooks,
    private readonly ipc: RuntimeIpc,
  ) {}

  async runQuery(input: RunQueryInput): Promise<RunQueryResult> {
    const { prompt, sessionId, resumeAt, containerInput } = input;
    const runtimePaths = containerInput.runtimePaths;
    if (!runtimePaths) {
      throw new Error('Missing runtimePaths in worker input');
    }

    if (resumeAt) {
      this.hooks.onLog(
        `Codex runtime ignores resumeAt cursor for now: ${resumeAt}`,
      );
    }

    // The SDK docs state that providing `env` disables inheritance from
    // `process.env`. That breaks ChatGPT login-backed auth in CODEX_HOME on
    // macOS, and can also drop OS-level config needed by the Codex CLI.
    // Keep the full worker environment intact and only pin CODEX_HOME per group.
    process.env.CODEX_HOME = runtimePaths.codexHome;
    const mergedNoProxy = mergeNoProxyHosts(
      process.env.NO_PROXY || process.env.no_proxy,
      containerInput.remoteMcpNoProxyHosts,
    );
    if (mergedNoProxy) {
      process.env.NO_PROXY = mergedNoProxy;
      process.env.no_proxy = mergedNoProxy;
      this.hooks.onLog(
        `Applied NO_PROXY hosts for remote MCP: ${mergedNoProxy}`,
      );
    }

    if (input.sdkEnv.OPENAI_API_KEY) {
      this.hooks.onLog('Codex runtime auth mode: OPENAI_API_KEY');
    } else {
      this.hooks.onLog(
        `Codex runtime auth mode: CODEX_HOME credentials (${runtimePaths.codexHome})`,
      );
    }

    const codex = new Codex(getCodexOptions(input));
    const threadOptions = getCodexThreadOptions(input);
    const thread = sessionId
      ? codex.resumeThread(sessionId, threadOptions)
      : codex.startThread(threadOptions);

    const abortController = new AbortController();
    let ipcPolling = true;
    let pollTimer: NodeJS.Timeout | null = null;
    let closedDuringQuery = false;
    let nextPrompt: string | undefined;
    let nextPromptBackgroundOnly = false;
    let queuedBackgroundPrompt: string | undefined;

    const stopIpcPolling = () => {
      ipcPolling = false;
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
    };

    const pollIpcDuringQuery = () => {
      if (!ipcPolling) return;

      if (this.ipc.shouldClose()) {
        closedDuringQuery = true;
        this.hooks.onLog('Close sentinel detected during Codex query');
        stopIpcPolling();
        abortController.abort();
        return;
      }

      const messages = this.ipc.drainIpcInput();
      if (messages.length > 0) {
        const backgroundMessages = messages.filter(
          (message) => message.type === 'background_activity',
        );
        const regularMessages = messages.filter(
          (message) => message.type === 'message',
        );

        if (backgroundMessages.length > 0) {
          const backgroundPrompt = backgroundMessages
            .map((message) => message.text)
            .join('\n');
          queuedBackgroundPrompt = queuedBackgroundPrompt
            ? `${queuedBackgroundPrompt}\n${backgroundPrompt}`
            : backgroundPrompt;
          this.hooks.onLog(
            `Queued ${backgroundMessages.length} background IPC update(s) for the next turn`,
          );
        }

        if (regularMessages.length > 0) {
          nextPrompt = [
            queuedBackgroundPrompt,
            regularMessages.map((message) => message.text).join('\n'),
          ]
            .filter(Boolean)
            .join('\n');
          nextPromptBackgroundOnly = false;
          this.hooks.onLog(
            `Received ${regularMessages.length} IPC message(s) during Codex query; interrupting turn`,
          );
          stopIpcPolling();
          abortController.abort();
        }
        return;
      }

      pollTimer = setTimeout(pollIpcDuringQuery, this.ipc.ipcPollMs);
    };

    let finalText = '';
    let newSessionId = thread.id || sessionId || undefined;
    let usage: TurnUsage | undefined;
    let usedSendMessageTool = false;

    pollTimer = setTimeout(pollIpcDuringQuery, this.ipc.ipcPollMs);

    try {
      const streamed = await thread.runStreamed(prompt, {
        signal: abortController.signal,
      });
      for await (const event of streamed.events) {
        if (event.type === 'thread.started') {
          newSessionId = event.thread_id;
        }

        if (isSuccessfulSendMessageCall(event)) {
          usedSendMessageTool = true;
          this.hooks.onLog(
            'Detected nanoclaw/send_message in turn; suppressing final auto-delivery',
          );
        }

        if (
          event.type === 'item.completed' &&
          event.item.type === 'agent_message'
        ) {
          finalText = event.item.text || finalText;
        }

        if (event.type === 'turn.completed') {
          usage = {
            inputTokens: event.usage.input_tokens,
            cachedInputTokens: event.usage.cached_input_tokens,
            outputTokens: event.usage.output_tokens,
          };
        }

        const summaries = eventSummary(event);
        for (const summary of summaries) {
          this.hooks.onLog(`[codex] ${summary}`);
        }
      }
    } catch (error) {
      if (
        !abortController.signal.aborted ||
        (!closedDuringQuery && nextPrompt == null && !isAbortError(error))
      ) {
        throw error;
      }

      this.hooks.onLog('Codex query interrupted to handle IPC input');
    } finally {
      stopIpcPolling();
    }

    if (closedDuringQuery) {
      return {
        newSessionId: newSessionId || undefined,
        lastAssistantUuid: undefined,
        closedDuringQuery: true,
        usage,
      };
    }

    if (nextPrompt != null) {
      return {
        newSessionId: newSessionId || undefined,
        lastAssistantUuid: undefined,
        closedDuringQuery: false,
        nextPrompt,
        nextPromptBackgroundOnly,
        usage,
      };
    }

    if (queuedBackgroundPrompt != null) {
      return {
        newSessionId: newSessionId || undefined,
        lastAssistantUuid: undefined,
        closedDuringQuery: false,
        nextPrompt: queuedBackgroundPrompt,
        nextPromptBackgroundOnly: true,
        usage,
      };
    }

    if (
      containerInput.suppressConversationArchive !== true &&
      input.backgroundOnly !== true
    ) {
      archiveCodexTurn(
        prompt,
        finalText,
        runtimePaths.groupPath,
        newSessionId,
        containerInput.taskSource,
      );
    }
    if (input.backgroundOnly !== true) {
      this.hooks.onResult(
        resolveFinalAutoDeliveryResult(finalText, usedSendMessageTool),
        newSessionId || undefined,
        usage,
      );
    }

    return {
      newSessionId: newSessionId || undefined,
      lastAssistantUuid: undefined,
      closedDuringQuery: false,
      usage,
    };
  }
}
