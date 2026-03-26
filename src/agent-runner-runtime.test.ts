import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'path';
import { pathToFileURL } from 'url';

const { startThreadMock, resumeThreadMock, codexCtorMock } = vi.hoisted(() => ({
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

async function loadCodexRuntimeModule(): Promise<{
  getCodexOptions: (input: any) => any;
  getCodexThreadOptions: (input: any) => any;
  mergeNoProxyHosts: (
    existingValue: string | undefined,
    hosts: string[] | undefined,
  ) => string | undefined;
  eventSummary: (event: any) => string[];
}> {
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
  return (await import(moduleUrl)) as {
    getCodexOptions: (input: any) => any;
    getCodexThreadOptions: (input: any) => any;
    mergeNoProxyHosts: (
      existingValue: string | undefined,
      hosts: string[] | undefined,
    ) => string | undefined;
    eventSummary: (event: any) => string[];
  };
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

function createRunQueryInput(): any {
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
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('interrupts the active turn when new IPC input arrives', async () => {
    const CodexRuntime = await loadCodexRuntime();
    const { thread } = createAbortableThread();
    resumeThreadMock.mockReturnValue(thread);

    const onLog = vi.fn();
    const onResult = vi.fn();
    const drainIpcInput = vi
      .fn<() => Array<{ type: 'message'; text: string }>>()
      .mockReturnValueOnce([{ type: 'message', text: 'follow up' }]);

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

  it('uses container agentConfig model settings for thread options', async () => {
    const { getCodexThreadOptions } = await loadCodexRuntimeModule();
    const input = createRunQueryInput();
    input.containerInput.agentConfig = {
      model: 'gpt-5-codex',
      reasoningEffort: 'high',
    };
    input.sdkEnv = {
      NANOCLAW_CODEX_MODEL: 'legacy-model',
      NANOCLAW_CODEX_REASONING_EFFORT: 'low',
    };

    expect(getCodexThreadOptions(input)).toEqual(
      expect.objectContaining({
        model: 'gpt-5-codex',
        modelReasoningEffort: 'high',
      }),
    );
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

  it('formats command and MCP tool activity for worker logs', async () => {
    const { eventSummary } = await loadCodexRuntimeModule();

    const commandLines = eventSummary({
      type: 'item.completed',
      item: {
        id: 'cmd-1',
        type: 'command_execution',
        command: 'git status --short',
        aggregated_output: 'M src/container-runner.ts',
        exit_code: 0,
        status: 'completed',
      },
    });
    const toolLines = eventSummary({
      type: 'item.completed',
      item: {
        id: 'tool-1',
        type: 'mcp_tool_call',
        server: 'automation_server',
        tool: 'get_state',
        arguments: { entity_id: 'climate.living_room' },
        result: {
          content: [],
          structured_content: { state: 'cool' },
        },
        status: 'completed',
      },
    });

    expect(commandLines).toContain(
      'command completed: git status --short (status=completed, exit=0)',
    );
    expect(commandLines.join('\n')).toContain('command output:');
    expect(commandLines.join('\n')).toContain('M src/container-runner.ts');
    expect(toolLines).toContain(
      'mcp tool completed: automation_server/get_state (status=completed)',
    );
    expect(toolLines.join('\n')).toContain(
      '"entity_id": "climate.living_room"',
    );
    expect(toolLines.join('\n')).toContain('"state": "cool"');
  });

  it('merges configured remote MCP servers into the Codex config', async () => {
    const { getCodexOptions } = await loadCodexRuntimeModule();
    const input = createRunQueryInput();
    input.containerInput.remoteMcpServers = {
      docs: {
        type: 'http',
        url: 'https://docs.example.com/mcp',
        headers: {
          Authorization: 'Bearer test-token',
        },
      },
    };
    input.containerInput.remoteMcpBridgeNames = ['docs'];

    expect(getCodexOptions(input)).toEqual(
      expect.objectContaining({
        config: expect.objectContaining({
          mcp_servers: expect.objectContaining({
            nanoclaw: expect.any(Object),
            docs: {
              command: expect.any(String),
              args: expect.any(Array),
              env: {
                NANOCLAW_REMOTE_MCP_NAME: 'docs',
                NANOCLAW_REMOTE_MCP_URL: 'https://docs.example.com/mcp',
                NANOCLAW_REMOTE_MCP_HEADERS_JSON: JSON.stringify({
                  Authorization: 'Bearer test-token',
                }),
              },
            },
          }),
        }),
      }),
    );
  });

  it('merges agent codexConfigOverrides without overriding required runtime config', async () => {
    const { getCodexOptions } = await loadCodexRuntimeModule();
    const input = createRunQueryInput();
    input.containerInput.agentConfig = {
      codexConfigOverrides: {
        sandbox_workspace_write: {
          network_access: false,
          extra_flag: true,
        },
        mcp_servers: {
          attacker: {
            command: 'echo',
            args: ['bad'],
          },
        },
        user_defined_flag: 'enabled',
      },
    };

    const options = getCodexOptions(input);
    const config = options.config;
    expect(config.user_defined_flag).toBe('enabled');
    expect((config.sandbox_workspace_write as any).network_access).toBe(true);
    expect((config.sandbox_workspace_write as any).extra_flag).toBe(true);
    expect((config.mcp_servers as any).nanoclaw).toBeDefined();
  });

  it('merges remote MCP hosts into NO_PROXY', async () => {
    const { mergeNoProxyHosts } = await loadCodexRuntimeModule();

    expect(
      mergeNoProxyHosts('127.0.0.1,localhost', [
        'docs.example.com',
        '198.51.100.10',
      ]),
    ).toBe('127.0.0.1,localhost,docs.example.com,198.51.100.10');
    expect(mergeNoProxyHosts(undefined, ['docs.example.com'])).toBe(
      'docs.example.com',
    );
  });
});
