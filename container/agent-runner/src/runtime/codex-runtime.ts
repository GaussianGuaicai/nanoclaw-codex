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
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
]);

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

function getCodexProcessEnv(
  sdkEnv: Record<string, string | undefined>,
  codexHome: string,
): Record<string, string> {
  const passthroughKeys = new Set([
    'PATH',
    'HOME',
    'SHELL',
    'TZ',
    'LANG',
    'LC_ALL',
    'TMPDIR',
    'TERM',
    'COLORTERM',
  ]);

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(sdkEnv)) {
    if (!value) continue;
    if (BLOCKED_ENV_VARS.has(key)) continue;
    if (passthroughKeys.has(key)) {
      env[key] = value;
    }
  }

  env.CODEX_HOME = codexHome;
  return env;
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

function getCodexOptions(input: RunQueryInput): CodexOptions {
  const { sdkEnv, containerInput } = input;
  const runtimePaths = containerInput.runtimePaths;
  if (!runtimePaths) {
    throw new Error('Missing runtimePaths in worker input');
  }

  const skillsDir = path.join(process.cwd(), 'container', 'skills');
  const skillConfigs =
    fs.existsSync(skillsDir)
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

  return {
    ...(sdkEnv.OPENAI_API_KEY ? { apiKey: sdkEnv.OPENAI_API_KEY } : {}),
    baseUrl: sdkEnv.OPENAI_BASE_URL,
    env: getCodexProcessEnv(sdkEnv, runtimePaths.codexHome),
    config: {
      mcp_servers: {
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
      },
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
  constructor(private readonly hooks: RuntimeHooks) {}

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

    archiveCodexTurn(prompt, finalText, runtimePaths.groupPath, newSessionId);
    this.hooks.onResult(finalText || null, newSessionId || undefined);

    return {
      newSessionId: newSessionId || undefined,
      lastAssistantUuid: undefined,
      closedDuringQuery: false,
    };
  }
}
