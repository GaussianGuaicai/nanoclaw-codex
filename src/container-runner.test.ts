import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
const {
  fsMock,
  spawnMock,
  validateAdditionalMounts,
  readEnvFileMock,
  resolveGroupWorkerEnvMock,
  pruneWorkerLogsForGroupMock,
  codexAuthManagerMock,
  releaseStartupGateMock,
} = vi.hoisted(() => ({
  fsMock: {
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(() => ''),
    readdirSync: vi.fn(() => []),
    statSync: vi.fn(() => ({ isDirectory: () => true })),
    copyFileSync: vi.fn(),
    cpSync: vi.fn(),
    rmSync: vi.fn(),
  },
  spawnMock: vi.fn(),
  validateAdditionalMounts: vi.fn(() => []),
  readEnvFileMock: vi.fn(() => ({})),
  resolveGroupWorkerEnvMock: vi.fn(() => ({})),
  pruneWorkerLogsForGroupMock: vi.fn(() => ({
    removedFiles: 0,
    removedBytes: 0,
  })),
  releaseStartupGateMock: vi.fn(),
  codexAuthManagerMock: {
    isEnabled: vi.fn(() => true),
    syncGlobalToGroup: vi.fn(),
    enterStartupGate: vi.fn(async () => releaseStartupGateMock),
    promoteGroupToGlobalIfNewer: vi.fn(),
  },
}));

vi.mock('./config.js', () => ({
  AGENT_MAX_OUTPUT_SIZE: 10485760,
  AGENT_TIMEOUT: 1800000,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000,
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      ...fsMock,
    },
  };
});

vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts,
}));

vi.mock('./env.js', () => ({
  readEnvFile: readEnvFileMock,
}));

vi.mock('./group-secrets.js', () => ({
  resolveGroupWorkerEnv: resolveGroupWorkerEnvMock,
}));

vi.mock('./log-maintenance.js', () => ({
  pruneWorkerLogsForGroup: pruneWorkerLogsForGroupMock,
}));

vi.mock('./codex-auth-manager.js', () => ({
  classifyFailureKind: (raw?: string) => {
    const text = (raw || '').toLowerCase();
    if (
      text.includes('refresh_token_reused') ||
      text.includes('provided authentication token is expired') ||
      text.includes('could not be refreshed') ||
      text.includes('failed to refresh token')
    ) {
      return 'auth_failure';
    }
    if (text.includes('timed out')) return 'timeout';
    if (text.includes('spawn error')) return 'spawn_error';
    if (text.includes('failed to parse worker output'))
      return 'output_parse_error';
    return 'worker_error';
  },
  codexAuthManager: codexAuthManagerMock,
}));

function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: (...args: unknown[]) => spawnMock(...args),
  };
});

import fs from 'fs';
import {
  buildAgentExecutionLayout,
  ContainerInput,
  ContainerOutput,
  runContainerAgent,
} from './container-runner.js';
import type { RegisteredGroup } from './types.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  proc.stdout.push(
    `${OUTPUT_START_MARKER}\n${JSON.stringify(output)}\n${OUTPUT_END_MARKER}\n`,
  );
}

function mockExistingPaths(paths: string[]): void {
  const resolved = new Set(paths);
  fsMock.existsSync.mockImplementation(((inputPath: unknown) =>
    resolved.has(String(inputPath))) as any);
  fsMock.readFileSync.mockImplementation(((inputPath: unknown) =>
    resolved.has(String(inputPath)) ? 'instruction content' : '') as any);
}

describe('container-runner worker execution', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    readEnvFileMock.mockReturnValue({});
    resolveGroupWorkerEnvMock.mockReturnValue({});
    pruneWorkerLogsForGroupMock.mockClear();
    releaseStartupGateMock.mockClear();
    codexAuthManagerMock.isEnabled.mockReturnValue(true);
    codexAuthManagerMock.syncGlobalToGroup.mockClear();
    codexAuthManagerMock.enterStartupGate.mockClear();
    codexAuthManagerMock.enterStartupGate.mockImplementation(
      async () => releaseStartupGateMock,
    );
    codexAuthManagerMock.promoteGroupToGlobalIfNewer.mockClear();
    fakeProc = createFakeProcess();
    spawnMock.mockReturnValue(fakeProc);
    validateAdditionalMounts.mockReturnValue([]);
    mockExistingPaths([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds a main-group execution layout with snapshots and writable roots', () => {
    validateAdditionalMounts.mockReturnValue([
      {
        hostPath: '/allowed/docs',
        containerPath: '/workspace/extra/docs',
        readonly: true,
      },
      {
        hostPath: '/allowed/repo',
        containerPath: '/workspace/extra/repo',
        readonly: false,
      },
    ] as any);
    mockExistingPaths([
      '/tmp/nanoclaw-test-groups/global',
      '/tmp/nanoclaw-test-groups/test-group/groups/test-group/preferences.md',
      '/tmp/nanoclaw-test-data/sessions/test-group/sandbox-context/global/AGENTS.md',
      '/tmp/nanoclaw-test-data/sessions/test-group/sandbox-context/extra/docs/AGENTS.md',
      '/allowed/repo/AGENTS.md',
    ]);

    const layout = buildAgentExecutionLayout(
      {
        ...testGroup,
        isMain: true,
        containerConfig: {
          additionalMounts: [
            { hostPath: '/allowed/docs' },
            { hostPath: '/allowed/repo', readonly: false },
          ],
        },
      },
      true,
    );

    expect(layout.groupPath).toBe('/tmp/nanoclaw-test-groups/test-group');
    expect(layout.codexHome).toBe(
      '/tmp/nanoclaw-test-data/sessions/test-group/.codex',
    );
    expect(layout.writableRoots).not.toContain(process.cwd());
    expect(layout.writableRoots).toContain('/allowed/repo');
    expect(layout.additionalDirectories).toContain(
      '/tmp/nanoclaw-test-data/sessions/test-group/sandbox-context',
    );
    expect(layout.sharedInstructionFiles).toEqual(
      expect.arrayContaining([
        '/tmp/nanoclaw-test-groups/test-group/groups/test-group/preferences.md',
        '/tmp/nanoclaw-test-data/sessions/test-group/sandbox-context/global/AGENTS.md',
        '/tmp/nanoclaw-test-data/sessions/test-group/sandbox-context/extra/docs/AGENTS.md',
        '/allowed/repo/AGENTS.md',
      ]),
    );
    expect(layout.snapshotMappings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourcePath: process.cwd(),
          targetPath:
            '/tmp/nanoclaw-test-data/sessions/test-group/sandbox-context/project',
          mode: 'snapshot',
        }),
        expect.objectContaining({
          sourcePath: '/tmp/nanoclaw-test-groups/global',
          mode: 'snapshot',
        }),
        expect.objectContaining({
          sourcePath: '/allowed/docs',
          mode: 'snapshot',
        }),
        expect.objectContaining({
          sourcePath: '/allowed/repo',
          mode: 'writable-root',
        }),
      ]),
    );
    expect(fs.cpSync).toHaveBeenCalledWith(
      process.cwd(),
      '/tmp/nanoclaw-test-data/sessions/test-group/sandbox-context/project',
      { recursive: true },
    );
    expect(fs.rmSync).toHaveBeenCalledWith(
      '/tmp/nanoclaw-test-data/sessions/test-group/sandbox-context/project/.env',
      { recursive: true, force: true },
    );
    expect(fs.cpSync).toHaveBeenCalledWith(
      '/tmp/nanoclaw-test-groups/global',
      '/tmp/nanoclaw-test-data/sessions/test-group/sandbox-context/global',
      { recursive: true },
    );
  });

  it('prefers standard group instruction paths over legacy nested paths', () => {
    mockExistingPaths([
      '/tmp/nanoclaw-test-groups/test-group/preferences.md',
      '/tmp/nanoclaw-test-groups/test-group/groups/test-group/preferences.md',
    ]);

    const layout = buildAgentExecutionLayout(testGroup, false);

    expect(layout.sharedInstructionFiles).toContain(
      '/tmp/nanoclaw-test-groups/test-group/preferences.md',
    );
    expect(layout.sharedInstructionFiles).not.toContain(
      '/tmp/nanoclaw-test-groups/test-group/groups/test-group/preferences.md',
    );
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      { ...testInput },
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(1830000);
    fakeProc.emit('close', 137);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('writes prompt and streamed result into worker log when enabled', async () => {
    mockExistingPaths(['/tmp/nanoclaw-test-groups/test-group/preferences.md']);

    const resultPromise = runContainerAgent(
      testGroup,
      {
        ...testInput,
        prompt: 'WebSocket-triggered prompt body',
        workerLogDetail: {
          includePrompt: true,
          includeResult: true,
        },
        contextDebug: {
          bootstrapUsed: true,
          memoryRefreshUsed: false,
          summaryIncluded: true,
          recentTurnsScope: 'source-only',
          recentTurnCount: 3,
        },
      },
      () => {},
      async () => {},
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'No user-facing action needed.',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    await resultPromise;

    const logWrite = fsMock.writeFileSync.mock.calls.find(
      ([filePath]) =>
        typeof filePath === 'string' && filePath.includes('worker-'),
    );

    expect(logWrite).toBeDefined();
    expect(String(logWrite?.[0])).toMatch(
      /worker-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}[+-]\d{2}-\d{2}\.log$/,
    );
    expect(logWrite?.[1]).toContain('=== Prompt ===');
    expect(logWrite?.[1]).toMatch(
      /Timestamp: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}/,
    );
    expect(logWrite?.[1]).toContain('=== Shared Instructions ===');
    expect(logWrite?.[1]).toContain('=== Context Summary ===');
    expect(logWrite?.[1]).toContain('Bootstrap Used: true');
    expect(logWrite?.[1]).toContain('Memory Refresh Used: false');
    expect(logWrite?.[1]).toContain('Summary Included: true');
    expect(logWrite?.[1]).toContain('Recent Turns Scope: source-only');
    expect(logWrite?.[1]).toContain('Recent Turn Count: 3');
    expect(logWrite?.[1]).toContain(
      'Rule Priority: CURRENT_INPUT > Shared Instructions > Structured Summary > Recent Turns > Session Background',
    );
    expect(logWrite?.[1]).toContain('preferences.md');
    expect(logWrite?.[1]).not.toContain('/tmp/nanoclaw-test-groups/test-group');
    expect(logWrite?.[1]).toContain('WebSocket-triggered prompt body');
    expect(logWrite?.[1]).toContain('=== Result ===');
    expect(logWrite?.[1]).toContain('No user-facing action needed.');
    expect(pruneWorkerLogsForGroupMock).toHaveBeenCalledWith(
      '/tmp/nanoclaw-test-groups/test-group',
    );
  });

  it('truncates older recent turns before newer recent turns and current input', async () => {
    const longPrompt = [
      'CONTEXT_BUNDLE',
      '',
      'CONTEXT_RULES:',
      '- Keep recent context for debugging.',
      '',
      'STRUCTURED_SUMMARY_YAML:',
      'session_state:',
      '  task: "Debug worker logs."',
      '',
      'RECENT_TURNS:',
      '- role: user',
      '  source: websocket',
      '  at: 2026-04-01T00:00:00.000Z',
      '  content: |',
      `    OLDER TURN MARKER ${'A'.repeat(28000)}`,
      '- role: assistant',
      '  source: websocket',
      '  at: 2026-04-03T00:00:00.000Z',
      '  content: |',
      `    NEWER TURN MARKER ${'B'.repeat(4000)}`,
      '',
      'CURRENT_INPUT:',
      'source: websocket',
      'content: |',
      `  CURRENT INPUT MARKER ${'C'.repeat(6000)}`,
    ].join('\n');

    const resultPromise = runContainerAgent(
      testGroup,
      {
        ...testInput,
        prompt: longPrompt,
        workerLogDetail: {
          includePrompt: true,
        },
      },
      () => {},
      async () => {},
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: '<internal>ok</internal>',
      newSessionId: 'session-789',
    });

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    await resultPromise;

    const logWrite = fsMock.writeFileSync.mock.calls.find(
      ([filePath]) =>
        typeof filePath === 'string' && filePath.includes('worker-'),
    );
    const logText = String(logWrite?.[1] ?? '');

    expect(logText).toContain('=== Prompt ===');
    expect(logText).toContain('RECENT_TURNS:');
    expect(logText).toContain(
      '[TRUNCATED]: prompt preview omitted older recent turns to preserve CURRENT_INPUT',
    );
    expect(logText).not.toContain('OLDER TURN MARKER');
    expect(logText).toContain('NEWER TURN MARKER');
    expect(logText).toContain('CURRENT_INPUT:');
    expect(logText).toContain('CURRENT INPUT MARKER');
  });

  it('includes worker stderr trace in successful worker logs', async () => {
    const resultPromise = runContainerAgent(
      testGroup,
      {
        ...testInput,
        prompt: 'Trace prompt',
      },
      () => {},
      async () => {},
    );

    fakeProc.stderr.push(
      '[agent-runner] [codex] command completed: git status --short (status=completed, exit=0)\n',
    );
    fakeProc.stderr.push(
      '[agent-runner] [codex] command output:\n  M src/container-runner.ts\n',
    );
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'ok',
      newSessionId: 'session-trace',
    });

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    await resultPromise;

    const logWrite = fsMock.writeFileSync.mock.calls.find(
      ([filePath]) =>
        typeof filePath === 'string' && filePath.includes('worker-'),
    );

    expect(logWrite).toBeDefined();
    expect(String(logWrite?.[1])).toContain('=== Worker Trace ===');
    expect(String(logWrite?.[1])).toContain(
      '[agent-runner] [codex] command completed: git status --short (status=completed, exit=0)',
    );
    expect(String(logWrite?.[1])).toContain('M src/container-runner.ts');
  });

  it('passes sanitized remote MCP servers to the worker input', async () => {
    const onOutput = vi.fn(async () => {});
    const stdinChunks: Buffer[] = [];
    readEnvFileMock.mockReturnValue({
      DOCS_API_TOKEN: 'docs-secret-token',
    });
    fakeProc.stdin.on('data', (chunk) => {
      stdinChunks.push(Buffer.from(chunk));
    });

    const resultPromise = runContainerAgent(
      {
        ...testGroup,
        containerConfig: {
          mcpServers: {
            internal_docs: {
              type: 'http',
              url: 'https://docs.example.com/mcp',
              bearerTokenEnvVar: 'DOCS_API_TOKEN',
              bypassProxy: true,
              bridgeToStdio: true,
            },
            updates_feed: {
              type: 'sse',
              url: 'https://updates.example.com/mcp',
              bridgeToStdio: true,
            },
            invalid_stdio: {
              type: 'stdio' as never,
              url: 'https://docs.example.com/mcp',
            },
          },
        },
      },
      { ...testInput },
      () => {},
      onOutput,
    );
    await Promise.resolve();

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'ok',
      newSessionId: 'session-remote-mcp',
    });
    fakeProc.emit('close', 0);

    const result = await resultPromise;
    expect(result.status).toBe('success');

    const workerInput = JSON.parse(Buffer.concat(stdinChunks).toString('utf8'));
    expect(workerInput.remoteMcpServers).toEqual({
      internal_docs: {
        type: 'http',
        url: 'https://docs.example.com/mcp',
        headers: {
          Authorization: 'Bearer docs-secret-token',
        },
      },
      updates_feed: {
        type: 'sse',
        url: 'https://updates.example.com/mcp',
      },
    });
    expect(workerInput.remoteMcpNoProxyHosts).toEqual(['docs.example.com']);
    expect(workerInput.remoteMcpBridgeNames).toEqual(['internal_docs']);
  });

  it('passes sdkSecrets and workerEnv to the worker input', async () => {
    const stdinChunks: Buffer[] = [];
    readEnvFileMock.mockReturnValue({
      OPENAI_API_KEY: 'sdk-secret',
    });
    resolveGroupWorkerEnvMock.mockReturnValue({
      HOME_ASSISTANT_URL: 'https://ha.example',
      HASS_ACCESS_TOKEN: 'worker-secret',
    });
    fakeProc.stdin.on('data', (chunk) => {
      stdinChunks.push(Buffer.from(chunk));
    });

    const resultPromise = runContainerAgent(
      testGroup,
      { ...testInput },
      () => {},
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'ok',
      newSessionId: 'session-worker-env',
    });
    fakeProc.emit('close', 0);

    const result = await resultPromise;
    expect(result.status).toBe('success');

    const workerInput = JSON.parse(Buffer.concat(stdinChunks).toString('utf8'));
    expect(workerInput.sdkSecrets).toEqual({
      OPENAI_API_KEY: 'sdk-secret',
    });
    expect(workerInput.workerEnv).toEqual({
      HOME_ASSISTANT_URL: 'https://ha.example',
      HASS_ACCESS_TOKEN: 'worker-secret',
    });
  });

  it('uses auth manager sync + startup gate + promotion in CODEX_HOME mode', async () => {
    readEnvFileMock.mockReturnValue({});

    const resultPromise = runContainerAgent(
      testGroup,
      { ...testInput },
      () => {},
      async () => {},
    );
    await Promise.resolve();

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'ok',
      newSessionId: 'session-auth-manager',
    });
    fakeProc.emit('close', 0);
    await resultPromise;

    expect(codexAuthManagerMock.syncGlobalToGroup).toHaveBeenCalledWith(
      'test-group',
    );
    expect(codexAuthManagerMock.enterStartupGate).toHaveBeenCalledWith(
      'test-group',
    );
    expect(releaseStartupGateMock).toHaveBeenCalledTimes(1);
    expect(codexAuthManagerMock.promoteGroupToGlobalIfNewer).toHaveBeenCalledWith(
      'test-group',
    );
  });

  it('skips auth manager handshake when OPENAI_API_KEY is provided', async () => {
    readEnvFileMock.mockReturnValue({
      OPENAI_API_KEY: 'sdk-secret',
    });

    const resultPromise = runContainerAgent(testGroup, { ...testInput }, () => {});

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'ok',
      newSessionId: 'session-api-key',
    });
    fakeProc.emit('close', 0);
    await resultPromise;

    expect(codexAuthManagerMock.syncGlobalToGroup).not.toHaveBeenCalled();
    expect(codexAuthManagerMock.enterStartupGate).not.toHaveBeenCalled();
    expect(codexAuthManagerMock.promoteGroupToGlobalIfNewer).not.toHaveBeenCalled();
  });

  it('classifies refresh_token_reused worker failures as auth_failure', async () => {
    const resultPromise = runContainerAgent(testGroup, { ...testInput }, () => {});
    await Promise.resolve();

    fakeProc.stderr.push('refresh_token_reused: token already consumed');
    fakeProc.emit('close', 1);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.failureKind).toBe('auth_failure');
  });

  it('redacts remote MCP headers before writing worker logs', async () => {
    readEnvFileMock.mockReturnValue({
      OPENAI_API_KEY: 'sdk-secret',
    });
    resolveGroupWorkerEnvMock.mockReturnValue({
      HASS_ACCESS_TOKEN: 'worker-secret',
    });
    const resultPromise = runContainerAgent(
      {
        ...testGroup,
        containerConfig: {
          mcpServers: {
            internal_docs: {
              type: 'http',
              url: 'https://docs.example.com/mcp',
              headers: {
                Authorization: 'Bearer secret-token',
                'X-Api-Key': 'top-secret',
              },
            },
          },
        },
      },
      { ...testInput },
      () => {},
    );

    fakeProc.stderr.push('worker failed');
    fakeProc.emit('close', 1);

    const result = await resultPromise;
    expect(result.status).toBe('error');

    const logWrite = fsMock.writeFileSync.mock.calls.find(([filePath]) =>
      String(filePath).includes(
        '/tmp/nanoclaw-test-groups/test-group/logs/worker-',
      ),
    );
    expect(logWrite).toBeDefined();

    const logContent = String(logWrite?.[1]);
    expect(logContent).toContain('"Authorization": "[REDACTED]"');
    expect(logContent).toContain('"X-Api-Key": "[REDACTED]"');
    expect(logContent).toContain('"OPENAI_API_KEY": "[REDACTED]"');
    expect(logContent).toContain('"HASS_ACCESS_TOKEN": "[REDACTED]"');
    expect(logContent).not.toContain('Bearer secret-token');
    expect(logContent).not.toContain('top-secret');
    expect(logContent).not.toContain('sdk-secret');
    expect(logContent).not.toContain('worker-secret');
  });

  it('timeout with no output resolves as error', async () => {
    mockExistingPaths(['/tmp/nanoclaw-test-groups/test-group/preferences.md']);
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      { ...testInput },
      () => {},
      onOutput,
    );

    await vi.advanceTimersByTimeAsync(1830000);
    fakeProc.emit('close', 137);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();

    const timeoutLog = fsMock.writeFileSync.mock.calls.find(
      ([, content]) =>
        typeof content === 'string' &&
        content.includes('=== Agent Run Log (TIMEOUT) ==='),
    );
    expect(timeoutLog).toBeDefined();
    expect(String(timeoutLog?.[1])).toContain('=== Shared Instructions ===');
    expect(String(timeoutLog?.[1])).toContain('preferences.md');
    expect(String(timeoutLog?.[1])).not.toContain('/tmp/nanoclaw-test-groups');
  });

  it('launches a local worker and injects runtimePaths into the worker input', async () => {
    const input: ContainerInput = { ...testInput };
    const resultPromise = runContainerAgent(testGroup, input, () => {});
    await Promise.resolve();

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(spawnMock).toHaveBeenCalledWith(
      'npx',
      expect.arrayContaining([
        'tsx',
        expect.stringContaining('container/agent-runner/src/index.ts'),
      ]),
      expect.objectContaining({ cwd: process.cwd() }),
    );
    expect(input.runtimePaths).toEqual(
      expect.objectContaining({
        groupPath: expect.stringContaining(
          '/tmp/nanoclaw-test-groups/test-group',
        ),
        ipcPath: expect.stringContaining(
          '/tmp/nanoclaw-test-data/ipc/test-group',
        ),
        codexHome: expect.stringContaining(
          '/tmp/nanoclaw-test-data/sessions/test-group/.codex',
        ),
      }),
    );
    expect(result.status).toBe('success');
  });

  it('passes agentConfig through to worker input', async () => {
    const stdinChunks: Buffer[] = [];
    fakeProc.stdin.on('data', (chunk: Buffer) => stdinChunks.push(chunk));

    const resultPromise = runContainerAgent(
      testGroup,
      {
        ...testInput,
        agentConfig: {
          model: 'gpt-5-codex',
          reasoningEffort: 'low',
          codexConfigOverrides: {
            user_flag: true,
          },
        },
      },
      () => {},
    );
    await Promise.resolve();

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'ok',
      newSessionId: 'session-agent-config',
    });
    fakeProc.emit('close', 0);
    await resultPromise;

    const workerInput = JSON.parse(Buffer.concat(stdinChunks).toString('utf8'));
    expect(workerInput.agentConfig).toEqual({
      model: 'gpt-5-codex',
      reasoningEffort: 'low',
      codexConfigOverrides: {
        user_flag: true,
      },
    });
  });
});
