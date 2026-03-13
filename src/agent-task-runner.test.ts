import { describe, expect, it, vi, beforeEach } from 'vitest';

const {
  runContainerAgentMock,
  writeTasksSnapshotMock,
  setSessionMock,
  getAllTasksMock,
} = vi.hoisted(() => ({
  runContainerAgentMock: vi.fn(),
  writeTasksSnapshotMock: vi.fn(),
  setSessionMock: vi.fn(),
  getAllTasksMock: vi.fn(() => []),
}));

vi.mock('./container-runner.js', () => ({
  runContainerAgent: runContainerAgentMock,
  writeTasksSnapshot: writeTasksSnapshotMock,
}));

vi.mock('./db.js', () => ({
  setSession: setSessionMock,
  getAllTasks: getAllTasksMock,
}));

import { runSingleTurnAgentTask } from './agent-task-runner.js';

describe('runSingleTurnAgentTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    expect(setSessionMock).toHaveBeenNthCalledWith(1, 'team', 'streamed-session');
    expect(setSessionMock).toHaveBeenNthCalledWith(2, 'team', 'final-session');
  });
});
