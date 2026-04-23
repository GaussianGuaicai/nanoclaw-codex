import { describe, expect, it, vi, beforeEach } from 'vitest';

const {
  runContainerAgentMock,
  writeTasksSnapshotMock,
  setSessionMock,
  getAllTasksMock,
  resolveAgentExecutionConfigMock,
  contextRuntimeMock,
  codexAuthManagerMock,
} = vi.hoisted(() => ({
  runContainerAgentMock: vi.fn(),
  writeTasksSnapshotMock: vi.fn(),
  setSessionMock: vi.fn(),
  getAllTasksMock: vi.fn(() => []),
  resolveAgentExecutionConfigMock: vi.fn(() => ({
    ok: true,
    config: { model: 'gpt-5-codex' },
  })) as any,
  codexAuthManagerMock: {
    isEnabled: vi.fn(() => true),
    attemptAutoRepair: vi.fn(() => true),
  },
  contextRuntimeMock: {
    buildLiveSessionKey: vi.fn(
      (params: {
        groupFolder: string;
        source: string;
        contextMode?: string;
      }) =>
        params.source === 'chat'
          ? `${params.groupFolder}::chat`
          : params.contextMode === 'group'
            ? `${params.groupFolder}::${params.source}`
            : undefined,
    ),
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
    prepareContextSessionForTurn: vi.fn(
      (params: { sessionId?: string }) => params.sessionId,
    ),
    getPromptWithBootstrapDetails: vi.fn((params: { prompt: string }) => ({
      prompt: params.prompt,
      contextDebug: {
        bootstrapUsed: true,
        memoryRefreshUsed: false,
        summaryIncluded: true,
        recentTurnsScope: 'shared',
        recentTurnCount: 0,
      },
    })),
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
vi.mock('./worker-config.js', () => ({
  loadWorkerAgentConfig: vi.fn(() => undefined),
}));
vi.mock('./context-runtime.js', () => contextRuntimeMock);
vi.mock('./codex-auth-manager.js', () => ({
  codexAuthManager: codexAuthManagerMock,
}));
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { runSingleTurnAgentTask } from './agent-task-runner.js';

describe('runSingleTurnAgentTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveAgentExecutionConfigMock.mockReturnValue({
      ok: true,
      config: { model: 'gpt-5-codex' },
    });
    codexAuthManagerMock.isEnabled.mockReturnValue(true);
    codexAuthManagerMock.attemptAutoRepair.mockReturnValue(true);
  });

  it('does not persist session updates for isolated context', async () => {
    runContainerAgentMock.mockResolvedValue({
      status: 'success',
      result: 'ok',
      newSessionId: 'isolated-session',
    });

    const sessions: Record<string, string> = {
      'team::scheduled': 'existing-session',
    };

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
    expect(sessions['team::scheduled']).toBe('existing-session');
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

    const sessions: Record<string, string> = {
      'team::scheduled': 'existing-session',
    };

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

    expect(sessions['team::scheduled']).toBe('final-session');
    expect(setSessionMock).toHaveBeenCalledTimes(2);
    expect(setSessionMock).toHaveBeenNthCalledWith(
      1,
      'team::scheduled',
      'streamed-session',
    );
    expect(setSessionMock).toHaveBeenNthCalledWith(
      2,
      'team::scheduled',
      'final-session',
    );
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
    contextRuntimeMock.getPromptWithBootstrapDetails.mockReturnValueOnce({
      prompt: 'bootstrapped prompt',
      contextDebug: {
        bootstrapUsed: true,
        memoryRefreshUsed: false,
        summaryIncluded: true,
        recentTurnsScope: 'shared',
        recentTurnCount: 0,
      },
    });
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

    expect(
      contextRuntimeMock.getPromptWithBootstrapDetails,
    ).toHaveBeenCalledWith(
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

  it('clears an oversized existing session before building the next prompt', async () => {
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
        compaction: {
          enabled: true,
          strategy: 'sliding-window',
          trigger: {
            lastInputTokensGte: 45000,
            fallbackEstimatedTokensGte: 38000,
          },
          window: {
            keepRecentTurns: 24,
            keepRecentEstimatedTokens: 12000,
          },
          restartSessionAfterCompact: true,
        },
      },
    });
    contextRuntimeMock.prepareContextSessionForTurn.mockReturnValueOnce(
      undefined,
    );
    runContainerAgentMock.mockResolvedValue({
      status: 'success',
      result: 'ok',
      newSessionId: 'fresh-session',
    });

    const sessions: Record<string, string> = {
      'team::scheduled': 'oversized-session',
    };

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

    expect(
      contextRuntimeMock.prepareContextSessionForTurn,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        groupFolder: 'team',
        sessionKey: 'team::scheduled',
        sessionId: 'oversized-session',
      }),
    );
    expect(
      contextRuntimeMock.getPromptWithBootstrapDetails,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: undefined,
      }),
    );
    expect(sessions['team::scheduled']).toBe('fresh-session');
  });

  it('adds conditional reply guidance to scheduled prompts when output delivery is enabled', async () => {
    runContainerAgentMock.mockResolvedValue({
      status: 'success',
      result: '<internal>done</internal>',
    });

    await runSingleTurnAgentTask(
      { folder: 'team', isMain: false } as any,
      {
        chatJid: 'chat@g.us',
        prompt: 'Check the task and notify only if needed.',
        contextMode: 'isolated',
        source: 'scheduled',
        deliverOutput: true,
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

    expect(runContainerAgentMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        prompt: expect.stringContaining(
          'If the task completed successfully but nothing needs to be surfaced now',
        ),
      }),
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('blocks queue and attempts auto-repair on auth failure', async () => {
    runContainerAgentMock.mockResolvedValue({
      status: 'error',
      result: null,
      error: 'refresh_token_reused',
      failureKind: 'auth_failure',
    });

    const blockAuth = vi.fn();
    const clearAuthBlock = vi.fn();
    const enqueueMessageCheck = vi.fn();

    const result = await runSingleTurnAgentTask(
      { folder: 'team', name: 'Team', isMain: false } as any,
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
          blockAuth,
          clearAuthBlock,
          enqueueMessageCheck,
        } as any,
      },
    );

    expect(result.status).toBe('error');
    expect(result.failureKind).toBe('auth_failure');
    expect(blockAuth).toHaveBeenCalledWith(
      'chat@g.us',
      'refresh_token_reused',
    );
    expect(codexAuthManagerMock.attemptAutoRepair).toHaveBeenCalledWith(
      'team',
      'refresh_token_reused',
    );
    expect(clearAuthBlock).toHaveBeenCalledWith('chat@g.us');
    expect(enqueueMessageCheck).toHaveBeenCalledWith('chat@g.us');
  });

  it('keeps group blocked when auth auto-repair fails', async () => {
    runContainerAgentMock.mockResolvedValue({
      status: 'error',
      result: null,
      error: 'Provided authentication token is expired',
      failureKind: 'auth_failure',
    });
    codexAuthManagerMock.attemptAutoRepair.mockReturnValue(false);

    const blockAuth = vi.fn();
    const clearAuthBlock = vi.fn();
    const enqueueMessageCheck = vi.fn();

    const result = await runSingleTurnAgentTask(
      { folder: 'team', name: 'Team', isMain: false } as any,
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
          blockAuth,
          clearAuthBlock,
          enqueueMessageCheck,
        } as any,
      },
    );

    expect(result.status).toBe('error');
    expect(result.failureKind).toBe('auth_failure');
    expect(blockAuth).toHaveBeenCalledTimes(1);
    expect(clearAuthBlock).not.toHaveBeenCalled();
    expect(enqueueMessageCheck).not.toHaveBeenCalled();
  });
});
