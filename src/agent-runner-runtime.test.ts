import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'path';
import { pathToFileURL } from 'url';

const {
  startThreadMock,
  resumeThreadMock,
  codexCtorMock,
} = vi.hoisted(() => ({
  startThreadMock: vi.fn(),
  resumeThreadMock: vi.fn(),
  codexCtorMock: vi.fn(),
}));

vi.mock('@openai/codex-sdk', () => {
  class MockCodex {
    constructor(...args: unknown[]) {
      codexCtorMock(...args);
    }

    startThread(...args: unknown[]) {
      return startThreadMock(...args);
    }

    resumeThread(...args: unknown[]) {
      return resumeThreadMock(...args);
    }
  }

  return {
    Codex: MockCodex,
  };
});
async function loadCodexRuntime(): Promise<
  new (...args: any[]) => {
    runQuery: (input: any) => Promise<any>;
  }
> {
  const moduleUrl = pathToFileURL(
    path.join(
      process.cwd(),
      'container',
      'agent-runner',
      'src',
      'runtime',
      'codex-runtime.ts',
    ),
  ).href;
  const mod = (await import(moduleUrl)) as {
    CodexRuntime: new (...args: any[]) => {
      runQuery: (input: any) => Promise<any>;
    };
  };

  return mod.CodexRuntime;
}

function createAbortableThread(threadId = 'thread-1') {
  return {
    thread: {
      id: threadId,
      runStreamed: vi.fn(
        async (_prompt: string, options?: { signal?: AbortSignal }) => {
          return {
            events: (async function* () {
              yield { type: 'thread.started' as const, thread_id: threadId };
              await new Promise<void>((resolve) => {
                if (options?.signal?.aborted) {
                  resolve();
                  return;
                }

                options?.signal?.addEventListener('abort', () => resolve(), {
                  once: true,
                });
              });

              const error = new Error('aborted');
              error.name = 'AbortError';
              throw error;
            })(),
          };
        },
      ),
    },
  };
}

function createRunQueryInput() {
  return {
    prompt: 'hello',
    sessionId: 'existing-session',
    mcpServerCommand: 'node',
    mcpServerArgs: ['ipc-mcp-stdio.js'],
    containerInput: {
      prompt: 'hello',
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      isMain: false,
      runtimePaths: {
        groupPath: '/tmp/group',
        ipcPath: '/tmp/ipc',
        codexHome: '/tmp/codex-home',
        additionalDirectories: [],
        writableRoots: [],
        sharedInstructionFiles: [],
      },
    },
    sdkEnv: {},
  };
}

describe('CodexRuntime IPC interruption', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('interrupts the active turn when new IPC input arrives', async () => {
    const CodexRuntime = await loadCodexRuntime();
    const { thread } = createAbortableThread();
    startThreadMock.mockReturnValue(thread);
    resumeThreadMock.mockReturnValue(thread);

    const onLog = vi.fn();
    const onResult = vi.fn();
    const drainIpcInput = vi
      .fn<() => string[]>()
      .mockReturnValueOnce(['follow up']);

    const runtime = new CodexRuntime(
      { onLog, onResult },
      {
        shouldClose: vi.fn(() => false),
        drainIpcInput,
        ipcPollMs: 50,
      },
    );

    const resultPromise = runtime.runQuery(createRunQueryInput());
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(50);
    const result = await resultPromise;

    expect(result).toEqual(
      expect.objectContaining({
        closedDuringQuery: false,
        nextPrompt: 'follow up',
      }),
    );
    expect(onResult).not.toHaveBeenCalled();
  });

  it('interrupts the active turn when close is requested', async () => {
    const CodexRuntime = await loadCodexRuntime();
    const { thread } = createAbortableThread();
    startThreadMock.mockReturnValue(thread);
    resumeThreadMock.mockReturnValue(thread);

    const onResult = vi.fn();
    const runtime = new CodexRuntime(
      { onLog: vi.fn(), onResult },
      {
        shouldClose: vi.fn(() => true),
        drainIpcInput: vi.fn(() => []),
        ipcPollMs: 50,
      },
    );

    const resultPromise = runtime.runQuery(createRunQueryInput());
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(50);
    const result = await resultPromise;

    expect(result).toEqual(
      expect.objectContaining({
        closedDuringQuery: true,
      }),
    );
    expect(onResult).not.toHaveBeenCalled();
  });
});
