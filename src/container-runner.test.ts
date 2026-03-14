import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
const { fsMock, spawnMock, validateAdditionalMounts, readEnvFileMock } =
  vi.hoisted(() => ({
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
}

describe('container-runner worker execution', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    readEnvFileMock.mockReturnValue({});
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
    const resultPromise = runContainerAgent(
      testGroup,
      {
        ...testInput,
        prompt: 'WebSocket-triggered prompt body',
        workerLogDetail: {
          includePrompt: true,
          includeResult: true,
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
    expect(logWrite?.[1]).toContain('WebSocket-triggered prompt body');
    expect(logWrite?.[1]).toContain('=== Result ===');
    expect(logWrite?.[1]).toContain('No user-facing action needed.');
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

  it('redacts remote MCP headers before writing worker logs', async () => {
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
    expect(logContent).not.toContain('Bearer secret-token');
    expect(logContent).not.toContain('top-secret');
  });

  it('timeout with no output resolves as error', async () => {
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
  });

  it('launches a local worker and injects runtimePaths into the worker input', async () => {
    const input: ContainerInput = { ...testInput };
    const resultPromise = runContainerAgent(testGroup, input, () => {});

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
});
