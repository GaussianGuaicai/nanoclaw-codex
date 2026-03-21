import { describe, expect, it, vi, beforeEach } from 'vitest';

const {
  runContainerAgentMock,
  writeTasksSnapshotMock,
  setSessionMock,
  getAllTasksMock,
  resolveAgentExecutionConfigMock,
  contextRuntimeMock,
} = vi.hoisted(() => ({
  runContainerAgentMock: vi.fn(),
  writeTasksSnapshotMock: vi.fn(),
  setSessionMock: vi.fn(),
  getAllTasksMock: vi.fn(() => []),
  resolveAgentExecutionConfigMock: vi.fn(() => ({
    ok: true,
    config: { model: 'gpt-5-codex' },
  })) as any,
  contextRuntimeMock: {
    isContextSourceEnabled: vi.fn(() => ({
      enabled: false,
      config: {
        enabled: false,
        summaryMemory: {
          enabled: false,
          model: 'gpt-5.4-mini',
          reasoningEffort: 'low',
          updateMinTurns: 2,
          maxItemsPerList: 12,
        },
      },
    })),
    buildPromptWithBootstrap: vi.fn(
      (params: { prompt: string }) => params.prompt,
    ),
    recordCompletedContextTurn: vi.fn(async () => {}),
  },
}));

vi.mock('./container-runner.js', () => ({
  runContainerAgent: runContainerAgentMock,
  writeTasksSnapshot: writeTasksSnapshotMock,
}));

vi.mock('./db.js', () => ({
  setSession: setSessionMock,
  getAllTasks: getAllTasksMock,
}));
vi.mock('./agent-config.js', () => ({
  resolveAgentExecutionConfig: resolveAgentExecutionConfigMock,
}));
vi.mock('./context-runtime.js', () => contextRuntimeMock);

import { runSingleTurnAgentTask } from './agent-task-runner.js';

describe('runSingleTurnAgentTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveAgentExecutionConfigMock.mockReturnValue({
      ok: true,
      config: { model: 'gpt-5-codex' },
    });
  });

  it('does not persist session updates for isolated context', async () => {
    runContainerAgentMock.mockResolvedValue({
      status: 'success',
      result: 'ok',
      newSessionId: 'isolated-session',
    });

    const sessions: Record<string, string> = { team: 'existing-session' };

    const result = await runSingleTurnAgentTask(
      { folder: 'team', isMain: false } as any,
      {
        chatJid: 'chat@g.us',
        prompt: 'ping',
        contextMode: 'isolated',
        source: 'scheduled',
      },
      {
        getSessions: () => sessions,
        onProcess: () => {},
        queue: {
          closeStdin: vi.fn(),
          notifyIdle: vi.fn(),
        } as any,
      },
    );

    expect(result.status).toBe('success');
    expect(sessions.team).toBe('existing-session');
    expect(setSessionMock).not.toHaveBeenCalled();
  });

  it('persists session updates for group context', async () => {
    runContainerAgentMock.mockImplementation(
      async (_group: any, _input: any, _onProcess: any, onOutput: any) => {
        await onOutput({
          status: 'success',
          result: null,
          newSessionId: 'streamed-session',
        });

        return {
          status: 'success',
          result: 'ok',
          newSessionId: 'final-session',
        };
      },
    );

    const sessions: Record<string, string> = { team: 'existing-session' };

    await runSingleTurnAgentTask(
      { folder: 'team', isMain: false } as any,
      {
        chatJid: 'chat@g.us',
        prompt: 'ping',
        contextMode: 'group',
        source: 'scheduled',
      },
      {
        getSessions: () => sessions,
        onProcess: () => {},
        queue: {
          closeStdin: vi.fn(),
          notifyIdle: vi.fn(),
        } as any,
      },
    );

    expect(sessions.team).toBe('final-session');
    expect(setSessionMock).toHaveBeenCalledTimes(2);
    expect(setSessionMock).toHaveBeenNthCalledWith(
      1,
      'team',
      'streamed-session',
    );
    expect(setSessionMock).toHaveBeenNthCalledWith(2, 'team', 'final-session');
  });

  it('fails fast when resolved agent config is invalid', async () => {
    resolveAgentExecutionConfigMock.mockReturnValueOnce({
      ok: false,
      scope: 'task',
      error: 'bad override',
    });

    const result = await runSingleTurnAgentTask(
      { folder: 'team', isMain: false } as any,
      {
        chatJid: 'chat@g.us',
        prompt: 'ping',
        contextMode: 'isolated',
        source: 'scheduled',
      },
      {
        getSessions: () => ({}),
        onProcess: () => {},
        queue: {
          closeStdin: vi.fn(),
          notifyIdle: vi.fn(),
        } as any,
      },
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('Agent config error (task)');
    expect(runContainerAgentMock).not.toHaveBeenCalled();
  });

  it('lets isolated tasks participate when isolatedTasks is enabled', async () => {
    contextRuntimeMock.isContextSourceEnabled.mockReturnValueOnce({
      enabled: true,
      config: {
        enabled: true,
        summaryMemory: {
          enabled: true,
          model: 'gpt-5.4-mini',
          reasoningEffort: 'low',
          updateMinTurns: 2,
          maxItemsPerList: 12,
        },
      },
    });
    contextRuntimeMock.buildPromptWithBootstrap.mockReturnValueOnce(
      'bootstrapped prompt',
    );
    runContainerAgentMock.mockResolvedValue({
      status: 'success',
      result: 'ok',
      newSessionId: 'fresh-session',
    });

    await runSingleTurnAgentTask(
      { folder: 'team', isMain: false } as any,
      {
        chatJid: 'chat@g.us',
        prompt: 'ping',
        contextMode: 'isolated',
        source: 'scheduled',
      },
      {
        getSessions: () => ({}),
        onProcess: () => {},
        queue: {
          closeStdin: vi.fn(),
          notifyIdle: vi.fn(),
        } as any,
      },
    );

    expect(contextRuntimeMock.buildPromptWithBootstrap).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'ping',
        sessionId: undefined,
      }),
    );
    expect(contextRuntimeMock.recordCompletedContextTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        contextMode: 'isolated',
        userPrompt: 'ping',
      }),
    );
    expect(setSessionMock).not.toHaveBeenCalled();
  });
});
