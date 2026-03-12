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
} from './types.js';

function parseBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

function getCodexThreadOptions(input: RunQueryInput): ThreadOptions {
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
    model: sdkEnv.NANOCLAW_CODEX_MODEL,
    modelReasoningEffort:
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

  return {
    ...(sdkEnv.OPENAI_API_KEY ? { apiKey: sdkEnv.OPENAI_API_KEY } : {}),
    baseUrl: sdkEnv.OPENAI_BASE_URL,
    config: {
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

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function archiveCodexTurn(
  prompt: string,
  response: string,
  groupPath: string,
  threadId?: string,
): void {
  const conversationsDir = path.join(groupPath, 'conversations');
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
        nextPrompt = messages.join('\n');
        this.hooks.onLog(
          `Received ${messages.length} IPC message(s) during Codex query; interrupting turn`,
        );
        stopIpcPolling();
        abortController.abort();
        return;
      }

      pollTimer = setTimeout(pollIpcDuringQuery, this.ipc.ipcPollMs);
    };

    let finalText = '';
    let newSessionId = thread.id || sessionId || undefined;

    pollTimer = setTimeout(pollIpcDuringQuery, this.ipc.ipcPollMs);

    try {
      const streamed = await thread.runStreamed(prompt, {
        signal: abortController.signal,
      });
      for await (const event of streamed.events) {
        if (event.type === 'thread.started') {
          newSessionId = event.thread_id;
        }

        if (
          event.type === 'item.completed' &&
          event.item.type === 'agent_message'
        ) {
          finalText = event.item.text || finalText;
        }

        const summary = eventSummary(event);
        if (summary) {
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
      };
    }

    if (nextPrompt != null) {
      return {
        newSessionId: newSessionId || undefined,
        lastAssistantUuid: undefined,
        closedDuringQuery: false,
        nextPrompt,
      };
    }

    archiveCodexTurn(prompt, finalText, runtimePaths.groupPath, newSessionId);
    this.hooks.onResult(finalText || null, newSessionId || undefined);

    return {
      newSessionId: newSessionId || undefined,
      lastAssistantUuid: undefined,
      closedDuringQuery: false,
    };
  }
}
