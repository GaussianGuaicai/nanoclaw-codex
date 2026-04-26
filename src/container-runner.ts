/**
 * Agent Runner for NanoClaw
 * Spawns per-group Codex worker processes and handles IPC-compatible streaming.
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  AGENT_MAX_OUTPUT_SIZE,
  AGENT_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
} from './config.js';
import {
  classifyFailureKind,
  codexAuthManager,
  ContainerFailureKind,
} from './codex-auth-manager.js';
import { readEnvFile } from './env.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { resolveGroupWorkerEnv } from './group-secrets.js';
import { logger } from './logger.js';
import { pruneWorkerLogsForGroup } from './log-maintenance.js';
import { validateAdditionalMounts } from './mount-security.js';
import {
  dedupeInstructionPaths,
  findInstructionFiles,
} from './shared-instructions.js';
import {
  formatLocalIsoTimestamp,
  formatLocalTimestampForFilename,
} from './time.js';
import {
  AgentExecutionConfig,
  RegisteredGroup,
  RemoteMcpServerConfig,
  TurnUsage,
} from './types.js';

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
const EXTRA_SNAPSHOT_PREFIX = '/workspace/extra/';
const MAX_WORKER_LOG_TEXT = 30000;
const TRUNCATED_MARKER = '[TRUNCATED]';

export interface AgentRuntimePaths {
  groupPath: string;
  ipcPath: string;
  codexHome: string;
  additionalDirectories: string[];
  writableRoots: string[];
  sharedInstructionFiles: string[];
}

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  taskSource?: 'chat' | 'scheduled' | 'websocket';
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  agentConfig?: AgentExecutionConfig;
  runtimePaths?: AgentRuntimePaths;
  remoteMcpServers?: Record<string, RemoteMcpServerConfig>;
  remoteMcpNoProxyHosts?: string[];
  remoteMcpBridgeNames?: string[];
  workerLogDetail?: {
    includePrompt?: boolean;
    includeResult?: boolean;
  };
  contextDebug?: {
    bootstrapUsed: boolean;
    memoryRefreshUsed: boolean;
    summaryIncluded: boolean;
    recentTurnsScope: 'shared' | 'source-only' | 'none';
    recentTurnCount: number;
  };
  maintenancePurpose?: 'summary-memory';
  suppressConversationArchive?: boolean;
  sdkSecrets?: Record<string, string>;
  workerEnv?: Record<string, string>;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  failureKind?: ContainerFailureKind;
  usage?: TurnUsage;
}

interface SnapshotMapping {
  sourcePath: string;
  targetPath: string;
  mode: 'snapshot' | 'writable-root';
}

export interface AgentExecutionLayout extends AgentRuntimePaths {
  snapshotMappings: SnapshotMapping[];
}

interface WorkerLaunchSpec {
  command: string;
  args: string[];
}

function buildPromptPreview(prompt: string, maxChars: number): string {
  if (prompt.length <= maxChars) {
    return prompt;
  }

  const contextAwarePreview = buildContextAwarePromptPreview(prompt, maxChars);
  if (contextAwarePreview) {
    return contextAwarePreview;
  }

  return `${prompt.slice(0, maxChars)}\n${TRUNCATED_MARKER}`;
}

function buildContextAwarePromptPreview(
  prompt: string,
  maxChars: number,
): string | null {
  const recentTurnsLabel = findRecentTurnsLabel(prompt);
  const currentInputIndex = prompt.indexOf('CURRENT_INPUT:');
  if (!recentTurnsLabel || currentInputIndex < 0) {
    return null;
  }

  const recentTurnsContentStart = prompt.indexOf('\n', recentTurnsLabel) + 1;
  if (
    recentTurnsContentStart <= 0 ||
    recentTurnsContentStart >= currentInputIndex
  ) {
    return null;
  }

  const prefix = prompt.slice(0, recentTurnsContentStart);
  const recentTurnsBody = prompt.slice(
    recentTurnsContentStart,
    currentInputIndex,
  );
  const suffix = prompt.slice(currentInputIndex);
  const markerBlock = `${TRUNCATED_MARKER}: prompt preview omitted older recent turns to preserve CURRENT_INPUT\n`;
  const fixedLength = prefix.length + suffix.length + markerBlock.length;

  if (fixedLength >= maxChars) {
    if (suffix.length + markerBlock.length >= maxChars) {
      const tailBudget = Math.max(0, maxChars - markerBlock.length);
      return `${markerBlock}${prompt.slice(-tailBudget)}`.slice(0, maxChars);
    }

    const prefixBudget = Math.max(
      0,
      maxChars - suffix.length - markerBlock.length,
    );
    const prefixPreview = trimToLineBoundary(prefix, prefixBudget);
    return `${prefixPreview}${markerBlock}${suffix}`;
  }

  const recentTurnsBudget = maxChars - fixedLength;
  const recentTurnsTail = trimRecentTurnsBodyFromFront(
    recentTurnsBody,
    recentTurnsBudget,
  );
  return `${prefix}${markerBlock}${recentTurnsTail}${suffix}`;
}

function findRecentTurnsLabel(prompt: string): number {
  const recentTurnsIndex = prompt.indexOf('RECENT_TURNS:');
  const selectedRecentTurnsIndex = prompt.indexOf('SELECTED_RECENT_TURNS:');

  if (recentTurnsIndex < 0) {
    return selectedRecentTurnsIndex;
  }
  if (selectedRecentTurnsIndex < 0) {
    return recentTurnsIndex;
  }

  return Math.min(recentTurnsIndex, selectedRecentTurnsIndex);
}

function trimRecentTurnsBodyFromFront(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  const rawTail = text.slice(-maxChars);
  const boundaryIndex = rawTail.indexOf('\n- role: ');
  if (boundaryIndex > 0) {
    return rawTail.slice(boundaryIndex + 1);
  }

  return rawTail;
}

function trimToLineBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  const preview = text.slice(0, maxChars);
  const lastNewline = preview.lastIndexOf('\n');
  if (lastNewline <= 0) {
    return preview.endsWith('\n') ? preview : `${preview}\n`;
  }

  return preview.slice(0, lastNewline + 1);
}

function loadRemoteMcpEnv(
  configuredServers?: Record<string, RemoteMcpServerConfig>,
): Record<string, string> {
  if (!configuredServers) return {};

  const envKeys = Array.from(
    new Set(
      Object.values(configuredServers)
        .map((server) => server.bearerTokenEnvVar)
        .filter(
          (value): value is string =>
            typeof value === 'string' && value.length > 0,
        ),
    ),
  );

  return envKeys.length > 0 ? readEnvFile(envKeys) : {};
}

function resolveRemoteMcpNoProxyHosts(
  configuredServers?: Record<string, RemoteMcpServerConfig>,
): string[] | undefined {
  if (!configuredServers) return undefined;

  const hosts = Object.values(configuredServers).flatMap((server) => {
    if (!server.bypassProxy) return [];
    try {
      const url = new URL(server.url);
      return url.hostname ? [url.hostname] : [];
    } catch {
      return [];
    }
  });

  return hosts.length > 0 ? Array.from(new Set(hosts)) : undefined;
}

function resolveRemoteMcpBridgeNames(
  configuredServers?: Record<string, RemoteMcpServerConfig>,
): string[] | undefined {
  if (!configuredServers) return undefined;

  const bridgeNames = Object.entries(configuredServers)
    .filter(
      ([, server]) => server.bridgeToStdio === true && server.type === 'http',
    )
    .map(([name]) => name);

  return bridgeNames.length > 0 ? bridgeNames : undefined;
}

function sanitizeRemoteMcpServers(
  configuredServers?: Record<string, RemoteMcpServerConfig>,
  envValues: Record<string, string> = {},
): Record<string, RemoteMcpServerConfig> | undefined {
  if (!configuredServers) return undefined;

  const sanitizedEntries = Object.entries(configuredServers).flatMap(
    ([name, server]) => {
      if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
        logger.warn({ name }, 'Skipping remote MCP server with invalid name');
        return [];
      }

      if (!server || (server.type !== 'http' && server.type !== 'sse')) {
        logger.warn(
          { name, type: server?.type },
          'Skipping remote MCP server with unsupported transport',
        );
        return [];
      }

      if (typeof server.url !== 'string') {
        logger.warn({ name }, 'Skipping remote MCP server with missing URL');
        return [];
      }

      let parsedUrl: URL;
      try {
        parsedUrl = new URL(server.url);
      } catch {
        logger.warn(
          { name, url: server.url },
          'Skipping remote MCP server with invalid URL',
        );
        return [];
      }

      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        logger.warn(
          { name, url: server.url },
          'Skipping remote MCP server with unsupported URL scheme',
        );
        return [];
      }

      const headers = {
        ...(server.headers
          ? Object.fromEntries(
              Object.entries(server.headers).filter(
                ([key, value]) =>
                  typeof key === 'string' &&
                  key.length > 0 &&
                  typeof value === 'string',
              ),
            )
          : {}),
      };

      if (server.bearerTokenEnvVar) {
        const token = envValues[server.bearerTokenEnvVar];
        if (!token) {
          logger.warn(
            { name, envVar: server.bearerTokenEnvVar },
            'Remote MCP bearer token env var is missing',
          );
        } else if (!headers.Authorization) {
          headers.Authorization = `Bearer ${token}`;
        }
      }

      return [
        [
          name,
          {
            type: server.type,
            url: parsedUrl.toString(),
            ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
          },
        ] as const,
      ];
    },
  );

  return sanitizedEntries.length > 0
    ? Object.fromEntries(sanitizedEntries)
    : undefined;
}

function redactRemoteMcpServersForLogging(
  configuredServers?: Record<string, RemoteMcpServerConfig>,
): Record<string, RemoteMcpServerConfig> | undefined {
  if (!configuredServers) return undefined;

  return Object.fromEntries(
    Object.entries(configuredServers).map(([name, server]) => [
      name,
      {
        ...server,
        ...(server.headers
          ? {
              headers: Object.fromEntries(
                Object.keys(server.headers).map((key) => [key, '[REDACTED]']),
              ),
            }
          : {}),
        ...(server.bearerTokenEnvVar
          ? {
              bearerTokenEnvVar: server.bearerTokenEnvVar,
            }
          : {}),
      },
    ]),
  );
}

function redactWorkerInputForLogging(input: ContainerInput): ContainerInput {
  return {
    ...input,
    runtimePaths: input.runtimePaths
      ? sanitizeAgentRuntimePathsForLogging(input.runtimePaths)
      : input.runtimePaths,
    remoteMcpServers: redactRemoteMcpServersForLogging(input.remoteMcpServers),
    ...(input.sdkSecrets
      ? {
          sdkSecrets: Object.fromEntries(
            Object.keys(input.sdkSecrets).map((key) => [key, '[REDACTED]']),
          ),
        }
      : {}),
    ...(input.workerEnv
      ? {
          workerEnv: Object.fromEntries(
            Object.keys(input.workerEnv).map((key) => [key, '[REDACTED]']),
          ),
        }
      : {}),
  };
}

function sanitizeWorkerLogPath(filePath: string): string {
  const normalized = path.normalize(filePath);
  const relative = path.relative(process.cwd(), normalized);

  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return relative;
  }

  return path.basename(normalized) || normalized;
}

function sanitizeAgentRuntimePathsForLogging(
  runtimePaths: AgentRuntimePaths,
): AgentRuntimePaths {
  return {
    groupPath: sanitizeWorkerLogPath(runtimePaths.groupPath),
    ipcPath: sanitizeWorkerLogPath(runtimePaths.ipcPath),
    codexHome: sanitizeWorkerLogPath(runtimePaths.codexHome),
    additionalDirectories: runtimePaths.additionalDirectories.map(
      sanitizeWorkerLogPath,
    ),
    writableRoots: runtimePaths.writableRoots.map(sanitizeWorkerLogPath),
    sharedInstructionFiles: runtimePaths.sharedInstructionFiles.map(
      sanitizeWorkerLogPath,
    ),
  };
}

function sanitizeAgentExecutionLayoutForLogging(
  layout: AgentExecutionLayout,
): AgentExecutionLayout {
  return {
    ...layout,
    ...sanitizeAgentRuntimePathsForLogging(layout),
    snapshotMappings: layout.snapshotMappings.map((mapping) => ({
      ...mapping,
      sourcePath: sanitizeWorkerLogPath(mapping.sourcePath),
      targetPath: sanitizeWorkerLogPath(mapping.targetPath),
    })),
  };
}

function buildContextLogLines(input: ContainerInput): string[] {
  if (!input.contextDebug) {
    return [
      '=== Context Summary ===',
      'Bootstrap Used: unknown',
      'Memory Refresh Used: unknown',
      'Summary Included: unknown',
      'Recent Turns Scope: unknown',
      'Recent Turn Count: unknown',
      'Rule Priority: CURRENT_INPUT > Shared Instructions > Structured Summary > Recent Turns > Session Background',
      '',
    ];
  }

  return [
    '=== Context Summary ===',
    `Bootstrap Used: ${input.contextDebug.bootstrapUsed}`,
    `Memory Refresh Used: ${input.contextDebug.memoryRefreshUsed}`,
    `Summary Included: ${input.contextDebug.summaryIncluded}`,
    `Recent Turns Scope: ${input.contextDebug.recentTurnsScope}`,
    `Recent Turn Count: ${input.contextDebug.recentTurnCount}`,
    'Rule Priority: CURRENT_INPUT > Shared Instructions > Structured Summary > Recent Turns > Session Background',
    '',
  ];
}

function ensureGroupRuntimeDirs(groupFolder: string): {
  codexHome: string;
  ipcPath: string;
} {
  const sessionDir = path.join(DATA_DIR, 'sessions', groupFolder);
  const codexHome = path.join(sessionDir, '.codex');
  const ipcPath = resolveGroupIpcPath(groupFolder);

  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(path.join(ipcPath, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(ipcPath, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(ipcPath, 'input'), { recursive: true });

  return { codexHome, ipcPath };
}

function copySnapshot(
  sourcePath: string,
  targetPath: string,
  options?: {
    removeEntries?: string[];
  },
): void {
  fs.rmSync(targetPath, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });

  const stat = fs.statSync(sourcePath);
  if (stat.isDirectory()) {
    const resolvedSource = path.resolve(sourcePath);
    const resolvedTarget = path.resolve(targetPath);
    const isWithin = (candidate: string, ancestor: string): boolean =>
      candidate === ancestor || candidate.startsWith(`${ancestor}${path.sep}`);

    if (isWithin(resolvedTarget, resolvedSource)) {
      fs.mkdirSync(targetPath, { recursive: true });
      for (const entry of fs.readdirSync(sourcePath)) {
        const entrySource = path.join(sourcePath, entry);
        if (isWithin(resolvedTarget, path.resolve(entrySource))) continue;
        fs.cpSync(entrySource, path.join(targetPath, entry), {
          recursive: true,
        });
      }
    } else {
      fs.cpSync(sourcePath, targetPath, { recursive: true });
    }

    for (const entry of options?.removeEntries || []) {
      fs.rmSync(path.join(targetPath, entry), { recursive: true, force: true });
    }
    return;
  }

  fs.copyFileSync(sourcePath, targetPath);
}

function dedupePaths(paths: string[]): string[] {
  return dedupeInstructionPaths(paths);
}

function resolveSnapshotTarget(
  contextRoot: string,
  containerPath: string,
): string {
  if (containerPath.startsWith(EXTRA_SNAPSHOT_PREFIX)) {
    return path.join(
      contextRoot,
      'extra',
      containerPath.slice(EXTRA_SNAPSHOT_PREFIX.length),
    );
  }

  return path.join(contextRoot, path.basename(containerPath));
}

function readSdkSecrets(): Record<string, string> {
  return readEnvFile([
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'NANOCLAW_CODEX_MODEL',
    'NANOCLAW_CODEX_SANDBOX_MODE',
    'NANOCLAW_CODEX_APPROVAL_POLICY',
    'NANOCLAW_CODEX_NETWORK_ACCESS',
    'NANOCLAW_CODEX_WEB_SEARCH_ENABLED',
    'NANOCLAW_CODEX_WEB_SEARCH_MODE',
    'NANOCLAW_CODEX_REASONING_EFFORT',
  ]);
}

export function buildAgentExecutionLayout(
  group: RegisteredGroup,
  isMain: boolean,
): AgentExecutionLayout {
  const projectRoot = process.cwd();
  const groupPath = resolveGroupFolderPath(group.folder);
  const { codexHome, ipcPath } = ensureGroupRuntimeDirs(group.folder);
  const sessionDir = path.dirname(codexHome);
  const contextRoot = path.join(sessionDir, 'sandbox-context');
  const snapshotMappings: SnapshotMapping[] = [];
  const writableRoots: string[] = [];
  const additionalDirectories: string[] = [];
  const sharedInstructionFiles: string[] = [];
  const readonlySnapshots: Array<{ sourcePath: string; targetPath: string }> =
    [];

  fs.mkdirSync(groupPath, { recursive: true });
  fs.rmSync(contextRoot, { recursive: true, force: true });

  for (const instructionFile of findInstructionFiles(groupPath)) {
    sharedInstructionFiles.push(instructionFile);
  }

  if (isMain) {
    readonlySnapshots.push({
      sourcePath: projectRoot,
      targetPath: path.join(contextRoot, 'project'),
    });
  }

  const globalDir = path.join(GROUPS_DIR, 'global');
  if (fs.existsSync(globalDir)) {
    readonlySnapshots.push({
      sourcePath: globalDir,
      targetPath: path.join(contextRoot, 'global'),
    });
  }

  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );

    for (const mount of validatedMounts) {
      if (mount.readonly) {
        readonlySnapshots.push({
          sourcePath: mount.hostPath,
          targetPath: resolveSnapshotTarget(contextRoot, mount.containerPath),
        });
        continue;
      }

      writableRoots.push(mount.hostPath);
      additionalDirectories.push(mount.hostPath);
      for (const instructionFile of findInstructionFiles(mount.hostPath)) {
        sharedInstructionFiles.push(instructionFile);
      }
      snapshotMappings.push({
        sourcePath: mount.hostPath,
        targetPath: mount.hostPath,
        mode: 'writable-root',
      });
    }
  }

  if (readonlySnapshots.length > 0) {
    fs.mkdirSync(contextRoot, { recursive: true });
    for (const snapshot of readonlySnapshots) {
      copySnapshot(snapshot.sourcePath, snapshot.targetPath, {
        removeEntries:
          snapshot.sourcePath === projectRoot ? ['.env'] : undefined,
      });
      for (const instructionFile of findInstructionFiles(snapshot.targetPath)) {
        sharedInstructionFiles.push(instructionFile);
      }
      snapshotMappings.push({
        sourcePath: snapshot.sourcePath,
        targetPath: snapshot.targetPath,
        mode: 'snapshot',
      });
    }
    additionalDirectories.unshift(contextRoot);
  }

  return {
    groupPath,
    ipcPath,
    codexHome,
    additionalDirectories: dedupePaths(additionalDirectories),
    writableRoots: dedupePaths(writableRoots),
    sharedInstructionFiles: dedupePaths(sharedInstructionFiles),
    snapshotMappings,
  };
}

function resolveWorkerLaunch(): WorkerLaunchSpec {
  const workerDist = path.join(
    process.cwd(),
    'container',
    'agent-runner',
    'dist',
    'index.js',
  );
  if (fs.existsSync(workerDist)) {
    return {
      command: process.execPath,
      args: [workerDist],
    };
  }

  const workerSrc = path.join(
    process.cwd(),
    'container',
    'agent-runner',
    'src',
    'index.ts',
  );
  const localTsx = path.join(process.cwd(), 'node_modules', '.bin', 'tsx');
  if (fs.existsSync(localTsx)) {
    return {
      command: localTsx,
      args: [workerSrc],
    };
  }

  return {
    command: 'npx',
    args: ['tsx', workerSrc],
  };
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, executionName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();
  const groupPath = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupPath, { recursive: true });

  const layout = buildAgentExecutionLayout(group, input.isMain);
  input.runtimePaths = layout;
  const loggableLayout = sanitizeAgentExecutionLayoutForLogging(layout);
  const remoteMcpEnv = loadRemoteMcpEnv(group.containerConfig?.mcpServers);
  input.remoteMcpServers = sanitizeRemoteMcpServers(
    group.containerConfig?.mcpServers,
    remoteMcpEnv,
  );
  input.remoteMcpNoProxyHosts = resolveRemoteMcpNoProxyHosts(
    group.containerConfig?.mcpServers,
  );
  input.remoteMcpBridgeNames = resolveRemoteMcpBridgeNames(
    group.containerConfig?.mcpServers,
  );

  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const executionName = `nanoclaw-${safeName}-${Date.now()}`;
  const launch = resolveWorkerLaunch();

  logger.debug(
    {
      group: group.name,
      executionName,
      command: launch.command,
      args: launch.args,
      layout: loggableLayout,
    },
    'Agent execution configuration',
  );

  logger.info(
    {
      group: group.name,
      executionName,
      isMain: input.isMain,
      writableRoots: loggableLayout.writableRoots,
      additionalDirectories: loggableLayout.additionalDirectories,
    },
    'Spawning local Codex worker',
  );

  const logsDir = path.join(groupPath, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  input.sdkSecrets = readSdkSecrets();
  input.workerEnv = resolveGroupWorkerEnv(group.folder);
  const usesCodexHomeAuth = !input.sdkSecrets.OPENAI_API_KEY;
  let releaseStartupGate: (() => void) | null = null;

  if (usesCodexHomeAuth && codexAuthManager.isEnabled()) {
    try {
      releaseStartupGate = await codexAuthManager.enterStartupGate(
        group.folder,
      );
    } catch (err) {
      logger.warn(
        { group: group.name, err },
        'auth-manager: startup gate acquire failed',
      );
    }

    try {
      codexAuthManager.syncGlobalToGroup(group.folder);
    } catch (err) {
      logger.warn(
        { group: group.name, err },
        'auth-manager: startup sync failed',
      );
    }
  }

  return new Promise((resolve) => {
    const worker = spawn(launch.command, launch.args, {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(worker, executionName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    const loggableInput = redactWorkerInputForLogging(input);
    worker.stdin.write(JSON.stringify(input));
    worker.stdin.end();
    delete input.sdkSecrets;
    delete input.workerEnv;

    let parseBuffer = '';
    let newSessionId: string | undefined;
    let latestUsage: TurnUsage | undefined;
    let latestFailureKind: ContainerFailureKind | undefined;
    let outputChain = Promise.resolve();
    const streamedResults: string[] = [];

    let startupGateReleased = false;
    const releaseGateIfHeld = (reason: string) => {
      if (!releaseStartupGate || startupGateReleased) return;
      startupGateReleased = true;
      releaseStartupGate();
      logger.debug({ group: group.name, reason }, 'Released startup auth gate');
    };
    const promoteGlobalCredentialsIfNeeded = () => {
      if (!(usesCodexHomeAuth && codexAuthManager.isEnabled())) return;
      try {
        codexAuthManager.promoteGroupToGlobalIfNewer(group.folder);
      } catch (err) {
        logger.warn(
          { group: group.name, err },
          'auth-manager: failed to promote group credentials',
        );
      }
    };

    worker.stdout.on('data', (data) => {
      const chunk = data.toString();
      if (
        chunk.includes(OUTPUT_START_MARKER) ||
        chunk.includes(OUTPUT_END_MARKER)
      ) {
        releaseGateIfHeld('output_marker');
      }

      if (!stdoutTruncated) {
        const remaining = AGENT_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Worker stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      if (!onOutput) return;

      parseBuffer += chunk;
      let startIdx: number;
      while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
        const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
        if (endIdx === -1) break;

        const jsonStr = parseBuffer
          .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
          .trim();
        parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

        try {
          const parsed: ContainerOutput = JSON.parse(jsonStr);
          if (parsed.status === 'error') {
            parsed.failureKind =
              parsed.failureKind || classifyFailureKind(parsed.error);
            latestFailureKind = parsed.failureKind;
          }
          if (parsed.newSessionId) {
            newSessionId = parsed.newSessionId;
          }
          if (parsed.usage) {
            latestUsage = parsed.usage;
          }
          if (parsed.result) {
            const rawResult =
              typeof parsed.result === 'string'
                ? parsed.result
                : JSON.stringify(parsed.result);
            streamedResults.push(rawResult);
          }
          hadStreamingOutput = true;
          resetTimeout();
          outputChain = outputChain.then(() => onOutput(parsed));
        } catch (err) {
          logger.warn(
            { group: group.name, error: err },
            'Failed to parse streamed worker output chunk',
          );
        }
      }
    });

    worker.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (
          line.includes('[codex] turn started') ||
          line.includes('[codex] turn failed') ||
          line.includes('[codex] stream error')
        ) {
          releaseGateIfHeld('codex_event');
        }
        if (line) logger.debug({ worker: group.folder }, line);
      }
      if (stderrTruncated) return;

      const remaining = AGENT_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Worker stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    let hadStreamingOutput = false;
    const configuredTimeout = group.containerConfig?.timeout || AGENT_TIMEOUT;
    const timeoutMs = Math.max(configuredTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      releaseGateIfHeld('timeout');
      logger.error({ group: group.name, executionName }, 'Worker timed out');
      worker.kill('SIGKILL');
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    worker.on('close', (code) => {
      clearTimeout(timeout);
      releaseGateIfHeld('close');
      const duration = Date.now() - startTime;

      if (timedOut) {
        const now = new Date();
        const ts = formatLocalTimestampForFilename(now);
        const timeoutLog = path.join(logsDir, `worker-${ts}.log`);
        const loggableTimeoutLayout =
          sanitizeAgentExecutionLayoutForLogging(layout);
        fs.writeFileSync(
          timeoutLog,
          [
            '=== Agent Run Log (TIMEOUT) ===',
            `Timestamp: ${formatLocalIsoTimestamp(now)}`,
            `Group: ${group.name}`,
            `Execution: ${executionName}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Had Streaming Output: ${hadStreamingOutput}`,
            '=== Shared Instructions ===',
            loggableTimeoutLayout.sharedInstructionFiles.join('\n') || '(none)',
          ].join('\n'),
        );
        try {
          pruneWorkerLogsForGroup(groupPath);
        } catch (err) {
          logger.warn(
            { err, group: group.name, groupPath },
            'Failed to prune worker logs after timeout',
          );
        }

        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, executionName, duration, code },
            'Worker timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({
              status: 'success',
              result: null,
              newSessionId,
              usage: latestUsage,
            });
          });
          return;
        }

        resolve({
          status: 'error',
          result: null,
          error: `Worker timed out after ${configuredTimeout}ms`,
          failureKind: 'timeout',
          usage: latestUsage,
        });
        return;
      }

      const now = new Date();
      const timestamp = formatLocalTimestampForFilename(now);
      const logFile = path.join(logsDir, `worker-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';
      const promptPreview = buildPromptPreview(
        input.prompt,
        MAX_WORKER_LOG_TEXT,
      );
      const resultPreviewRaw = streamedResults.join('\n\n---\n\n');
      const resultPreview =
        resultPreviewRaw.length > MAX_WORKER_LOG_TEXT
          ? `${resultPreviewRaw.slice(0, MAX_WORKER_LOG_TEXT)}\n${TRUNCATED_MARKER}`
          : resultPreviewRaw;
      const logLines = [
        '=== Agent Run Log ===',
        `Timestamp: ${formatLocalIsoTimestamp(now)}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        '',
      ];

      if (isVerbose || code !== 0) {
        logLines.push(
          '=== Input ===',
          JSON.stringify(loggableInput, null, 2),
          '',
          '=== Worker Launch ===',
          `${launch.command} ${launch.args.join(' ')}`,
          '',
          '=== Runtime Layout ===',
          JSON.stringify(layout, null, 2),
          '',
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          '',
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          '=== Input Summary ===',
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          '',
          ...buildContextLogLines(input),
          '=== Additional Directories ===',
          loggableLayout.additionalDirectories.join('\n') || '(none)',
          '',
          '=== Writable Roots ===',
          loggableLayout.writableRoots.join('\n') || '(none)',
          '',
          '=== Shared Instructions ===',
          loggableLayout.sharedInstructionFiles.join('\n') || '(none)',
          '',
        );

        if (input.workerLogDetail?.includePrompt === true) {
          logLines.push('=== Prompt ===', promptPreview || '(empty)', '');
        }

        if (input.workerLogDetail?.includeResult === true) {
          logLines.push('=== Result ===', resultPreview || '(no result)', '');
        }

        if (stderr.trim()) {
          logLines.push(
            `=== Worker Trace${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
            stderr,
            '',
          );
        }
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      try {
        pruneWorkerLogsForGroup(groupPath);
      } catch (err) {
        logger.warn(
          { err, group: group.name, groupPath },
          'Failed to prune worker logs after write',
        );
      }

      promoteGlobalCredentialsIfNeeded();

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr,
            stdout,
            logFile,
          },
          'Worker exited with error',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Worker exited with code ${code}: ${stderr.slice(-200)}`,
          failureKind: latestFailureKind || classifyFailureKind(stderr),
        });
        return;
      }

      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Worker completed (streaming mode)',
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId,
            usage: latestUsage,
          });
        });
        return;
      }

      try {
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);
        if (output.status === 'error') {
          output.failureKind =
            output.failureKind || classifyFailureKind(output.error);
        }
        if (output.usage) {
          latestUsage = output.usage;
        }
        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Worker completed',
        );
        resolve({
          ...output,
          usage: output.usage ?? latestUsage,
        });
      } catch (err) {
        logger.error(
          { group: group.name, stdout, stderr, error: err },
          'Failed to parse worker output',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse worker output: ${err instanceof Error ? err.message : String(err)}`,
          failureKind: 'output_parse_error',
        });
      }
    });

    worker.on('error', (err) => {
      clearTimeout(timeout);
      releaseGateIfHeld('spawn_error');
      logger.error(
        { group: group.name, executionName, error: err },
        'Worker spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Worker spawn error: ${err.message}`,
        failureKind: 'spawn_error',
      });
    });
  });
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  _registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const visibleGroups = isMain ? groups : [];
  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
