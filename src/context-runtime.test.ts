import { afterEach, describe, expect, it, vi } from 'vitest';

const { loadContextConfigMock, updateSummaryMemoryMock } = vi.hoisted(() => ({
  loadContextConfigMock: vi.fn(),
  updateSummaryMemoryMock: vi.fn(),
}));

vi.mock('./context-config.js', () => ({
  loadContextConfig: loadContextConfigMock,
}));

vi.mock('./summary-memory.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./summary-memory.js')>();
  return {
    ...actual,
    updateSummaryMemory: updateSummaryMemoryMock,
  };
});

import {
  _initTestDatabase,
  insertContextTurn,
  getOrCreateGroupMemoryState,
  listContextTurnsForGroup,
} from './db.js';
import {
  buildLiveSessionKey,
  buildPromptWithBootstrap,
  isContextSourceEnabled,
  prepareContextSessionForTurn,
  recordCompletedContextTurn,
} from './context-runtime.js';
import { RegisteredGroup } from './types.js';

const baseConfig = {
  enabled: true,
  summaryMemory: {
    enabled: true,
    model: 'gpt-5.4-mini',
    reasoningEffort: 'low' as const,
    updateMinTurns: 2,
    maxItemsPerList: 12,
  },
  compaction: {
    enabled: true,
    strategy: 'sliding-window' as const,
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
  sources: {
    chat: true,
    scheduledGroupContext: true,
    websocketGroupContext: true,
    isolatedTasks: false,
  },
};

const testGroup: RegisteredGroup = {
  name: 'Slack Main',
  folder: 'slack_main',
  trigger: '@Andy',
  added_at: '2026-03-22T00:00:00.000Z',
  isMain: true,
};

describe('isContextSourceEnabled', () => {
  afterEach(() => {
    _initTestDatabase();
    vi.clearAllMocks();
  });

  it('defaults to disabled when context config is off', () => {
    loadContextConfigMock.mockReturnValue({
      ...baseConfig,
      enabled: false,
    });

    expect(isContextSourceEnabled({ source: 'chat' }).enabled).toBe(false);
  });

  it('uses isolatedTasks for isolated scheduled/websocket tasks', () => {
    loadContextConfigMock.mockReturnValue(baseConfig);

    expect(
      isContextSourceEnabled({
        source: 'scheduled',
        contextMode: 'isolated',
      }).enabled,
    ).toBe(false);

    loadContextConfigMock.mockReturnValue({
      ...baseConfig,
      sources: {
        ...baseConfig.sources,
        isolatedTasks: true,
      },
    });

    expect(
      isContextSourceEnabled({
        source: 'scheduled',
        contextMode: 'isolated',
      }).enabled,
    ).toBe(true);
    expect(
      isContextSourceEnabled({
        source: 'websocket',
        contextMode: 'isolated',
      }).enabled,
    ).toBe(true);
  });
});

describe('buildLiveSessionKey', () => {
  it('scopes chat and group event sessions separately', () => {
    expect(
      buildLiveSessionKey({
        groupFolder: 'slack_main',
        source: 'chat',
      }),
    ).toBe('slack_main::chat');
    expect(
      buildLiveSessionKey({
        groupFolder: 'slack_main',
        source: 'websocket',
        contextMode: 'group',
      }),
    ).toBe('slack_main::websocket');
    expect(
      buildLiveSessionKey({
        groupFolder: 'slack_main',
        source: 'scheduled',
        contextMode: 'isolated',
      }),
    ).toBeUndefined();
  });
});

describe('buildPromptWithBootstrap', () => {
  afterEach(() => {
    _initTestDatabase();
    vi.clearAllMocks();
  });

  it('limits non-chat bootstrap history to the current source and adds source-scoped guidance', () => {
    loadContextConfigMock.mockReturnValue(baseConfig);

    insertContextTurn({
      group_folder: testGroup.folder,
      chat_jid: 'chat:test-room',
      source: 'chat',
      role: 'user',
      content: 'Chat asked about recent device events.',
      created_at: '2026-03-25T13:57:11.000Z',
      est_tokens: 10,
    });
    insertContextTurn({
      group_folder: testGroup.folder,
      chat_jid: 'chat:test-room',
      source: 'scheduled',
      role: 'user',
      content: 'Scheduled task should run the target action.',
      created_at: '2026-03-25T14:00:34.000Z',
      est_tokens: 10,
    });

    const prompt = buildPromptWithBootstrap({
      groupFolder: testGroup.folder,
      source: 'scheduled',
      prompt: 'Run the scheduled task now.',
    });

    expect(prompt).toContain('CURRENT_INPUT is the task to execute now');
    expect(prompt).toContain('source `scheduled`');
    expect(prompt).toContain('Scheduled task should run the target action.');
    expect(prompt).not.toContain('Chat asked about recent device events.');
  });

  it('keeps shared recent turns for chat bootstrap', () => {
    loadContextConfigMock.mockReturnValue(baseConfig);

    insertContextTurn({
      group_folder: testGroup.folder,
      chat_jid: 'chat:test-room',
      source: 'chat',
      role: 'user',
      content: 'Chat asked about recent device events.',
      created_at: '2026-03-25T13:57:11.000Z',
      est_tokens: 10,
    });
    insertContextTurn({
      group_folder: testGroup.folder,
      chat_jid: 'chat:test-room',
      source: 'websocket',
      role: 'assistant',
      content: 'Realtime event was notify-only.',
      created_at: '2026-03-25T14:26:46.000Z',
      est_tokens: 10,
    });

    const prompt = buildPromptWithBootstrap({
      groupFolder: testGroup.folder,
      source: 'chat',
      prompt: 'Answer the user.',
    });

    expect(prompt).toContain('may include multiple sources');
    expect(prompt).toContain('Chat asked about recent device events.');
    expect(prompt).toContain('Realtime event was notify-only.');
  });
});

describe('recordCompletedContextTurn', () => {
  afterEach(() => {
    _initTestDatabase();
    vi.clearAllMocks();
  });

  it('persists turns and updates summary state', async () => {
    loadContextConfigMock.mockReturnValue({
      ...baseConfig,
      compaction: {
        ...baseConfig.compaction,
        trigger: {
          lastInputTokensGte: 999999,
          fallbackEstimatedTokensGte: 999999,
        },
      },
    });
    updateSummaryMemoryMock.mockResolvedValue({
      yaml: [
        'session_state:',
        '  task: "Track the latest conversation state."',
        '  decisions: []',
        '  constraints: []',
        '  active_entities: []',
        '  open_questions: []',
        '  important_paths: []',
        '  recent_failures: []',
        '  user_preferences: []',
      ].join('\n'),
      repaired: false,
    });

    const closeWorker = vi.fn();
    const clearSessionCache = vi.fn();

    await recordCompletedContextTurn({
      group: testGroup,
      chatJid: 'slack:C0AL00L1C7J',
      source: 'chat',
      contextMode: 'group',
      sessionKey: 'slack_main::chat',
      userPrompt: 'What tools do you have?',
      assistantResponse: 'I can inspect files, run commands, and help debug.',
      usage: {
        inputTokens: 1200,
        outputTokens: 300,
      },
      closeWorker,
      clearSessionCache,
      invokeInternalPrompt: vi.fn(),
    });

    const turns = listContextTurnsForGroup(testGroup.folder);
    const state = getOrCreateGroupMemoryState(testGroup.folder);

    expect(turns).toHaveLength(2);
    expect(turns.map((turn) => turn.role)).toEqual(['user', 'assistant']);
    expect(updateSummaryMemoryMock).toHaveBeenCalledTimes(1);
    expect(updateSummaryMemoryMock.mock.calls[0][0].deltaTurns).toHaveLength(2);
    expect(state.last_summarized_turn_id).toBe(2);
    expect(state.last_summary_at).toBeTruthy();
    expect(state.summary_yaml).toContain('Track the latest conversation state');
    expect(state.last_input_tokens).toBe(1200);
    expect(state.last_output_tokens).toBe(300);
    expect(closeWorker).not.toHaveBeenCalled();
    expect(clearSessionCache).not.toHaveBeenCalled();
  });

  it('advances the compaction boundary and clears the session when the window is exceeded', async () => {
    loadContextConfigMock.mockReturnValue({
      ...baseConfig,
      summaryMemory: {
        ...baseConfig.summaryMemory,
        enabled: false,
      },
      compaction: {
        ...baseConfig.compaction,
        trigger: {
          lastInputTokensGte: 1,
          fallbackEstimatedTokensGte: 1,
        },
        window: {
          keepRecentTurns: 2,
          keepRecentEstimatedTokens: 1,
        },
      },
    });

    const closeWorker = vi.fn();
    const clearSessionCache = vi.fn();
    const invokeInternalPrompt = vi.fn();

    await recordCompletedContextTurn({
      group: testGroup,
      chatJid: 'slack:C0AL00L1C7J',
      source: 'websocket',
      contextMode: 'group',
      sessionKey: 'slack_main::websocket',
      userPrompt: 'User prompt one.',
      assistantResponse: 'Assistant response one.',
      usage: {
        inputTokens: 5000,
        outputTokens: 200,
      },
      closeWorker,
      clearSessionCache,
      invokeInternalPrompt,
    });

    await recordCompletedContextTurn({
      group: testGroup,
      chatJid: 'slack:C0AL00L1C7J',
      source: 'websocket',
      contextMode: 'group',
      sessionKey: 'slack_main::websocket',
      userPrompt: 'User prompt two.',
      assistantResponse: 'Assistant response two.',
      usage: {
        inputTokens: 6000,
        outputTokens: 250,
      },
      closeWorker,
      clearSessionCache,
      invokeInternalPrompt,
    });

    const state = getOrCreateGroupMemoryState(testGroup.folder);
    const turns = listContextTurnsForGroup(testGroup.folder);

    expect(turns).toHaveLength(4);
    expect(updateSummaryMemoryMock).not.toHaveBeenCalled();
    expect(state.last_compacted_turn_id).toBe(2);
    expect(state.last_compaction_at).toBeTruthy();
    expect(state.last_summarized_turn_id).toBe(0);
    expect(closeWorker).toHaveBeenCalledTimes(1);
    expect(clearSessionCache).toHaveBeenCalledTimes(1);
  });
});

describe('prepareContextSessionForTurn', () => {
  afterEach(() => {
    _initTestDatabase();
    vi.clearAllMocks();
  });

  it('clears an existing session before the next turn when the previous turn already exceeded compaction limits', async () => {
    loadContextConfigMock.mockReturnValue(baseConfig);

    const clearSessionCache = vi.fn();
    const invokeInternalPrompt = vi.fn();

    await recordCompletedContextTurn({
      group: testGroup,
      chatJid: 'slack:C0AL00L1C7J',
      source: 'chat',
      contextMode: 'group',
      userPrompt: 'A short prompt.',
      assistantResponse: 'A short response.',
      usage: {
        inputTokens: 60000,
        outputTokens: 200,
      },
      closeWorker: vi.fn(),
      clearSessionCache: vi.fn(),
      invokeInternalPrompt,
    });

    const sessionId = prepareContextSessionForTurn({
      groupFolder: testGroup.folder,
      sessionKey: 'slack_main::chat',
      sessionId: 'existing-session',
      config: baseConfig,
      clearSessionCache,
    });

    expect(sessionId).toBeUndefined();
    expect(clearSessionCache).toHaveBeenCalledTimes(1);
  });
});
