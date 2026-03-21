import { afterEach, describe, expect, it, vi } from 'vitest';

const { loadContextConfigMock } = vi.hoisted(() => ({
  loadContextConfigMock: vi.fn(),
}));

vi.mock('./context-config.js', () => ({
  loadContextConfig: loadContextConfigMock,
}));

import { isContextSourceEnabled } from './context-runtime.js';

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

describe('isContextSourceEnabled', () => {
  afterEach(() => {
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
