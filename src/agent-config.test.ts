import fs from 'fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { testAgentConfigPath, readEnvFileMock } = vi.hoisted(() => ({
  testAgentConfigPath: '/tmp/nanoclaw-agent-config.test.json',
  readEnvFileMock: vi.fn(),
}));

vi.mock('./config.js', async () => {
  return {
    AGENT_CONFIG_PATH: testAgentConfigPath,
  };
});

vi.mock('./env.js', () => ({
  readEnvFile: readEnvFileMock,
}));

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  resetGlobalAgentConfigForTests,
  resolveAgentExecutionConfig,
} from './agent-config.js';

describe('agent-config resolver', () => {
  beforeEach(() => {
    resetGlobalAgentConfigForTests();
    readEnvFileMock.mockReset();
    readEnvFileMock.mockReturnValue({});
    delete process.env.NANOCLAW_CODEX_MODEL;
    delete process.env.NANOCLAW_CODEX_REASONING_EFFORT;
    try {
      fs.unlinkSync(testAgentConfigPath);
    } catch {
      // ignore
    }
  });

  afterEach(() => {
    try {
      fs.unlinkSync(testAgentConfigPath);
    } catch {
      // ignore
    }
  });

  it('uses legacy env defaults when no structured config exists', () => {
    readEnvFileMock.mockReturnValue({
      NANOCLAW_CODEX_MODEL: 'gpt-5-codex',
      NANOCLAW_CODEX_REASONING_EFFORT: 'medium',
    });

    const result = resolveAgentExecutionConfig({
      source: 'chat',
    });

    expect(result).toEqual({
      ok: true,
      config: {
        model: 'gpt-5-codex',
        reasoningEffort: 'medium',
      },
    });
  });

  it('applies precedence in order and keeps websocket lightweight by default', () => {
    readEnvFileMock.mockReturnValue({
      NANOCLAW_CODEX_MODEL: 'legacy-model',
      NANOCLAW_CODEX_REASONING_EFFORT: 'medium',
    });
    fs.writeFileSync(
      testAgentConfigPath,
      JSON.stringify({
        defaults: {
          model: 'global-model',
          codexConfigOverrides: {
            global_flag: true,
          },
        },
        bySource: {
          websocket: {
            model: 'global-ws-model',
            reasoningEffort: 'minimal',
          },
        },
      }),
    );

    const result = resolveAgentExecutionConfig({
      source: 'websocket',
      group: {
        name: 'g',
        folder: 'main',
        trigger: '@a',
        added_at: '2026-01-01T00:00:00.000Z',
        containerConfig: {
          agentConfig: {
            defaults: {
              model: 'group-default-model',
            },
            bySource: {
              websocket: {
                model: 'group-ws-model',
                codexConfigOverrides: {
                  group_flag: true,
                },
              },
            },
          },
        },
      },
      websocketOverride: {
        reasoningEffort: 'high',
      },
      taskOverride: {
        model: 'task-model',
        codexConfigOverrides: {
          task_flag: true,
        },
      },
    });

    expect(result).toEqual({
      ok: true,
      config: {
        model: 'task-model',
        reasoningEffort: 'high',
        codexConfigOverrides: {
          global_flag: true,
          group_flag: true,
          task_flag: true,
        },
      },
    });
  });

  it('applies default websocket lightweight profile when no layer sets reasoning', () => {
    const result = resolveAgentExecutionConfig({
      source: 'websocket',
    });

    expect(result).toEqual({
      ok: true,
      config: {
        reasoningEffort: 'low',
      },
    });
  });

  it('disables all execution when global config is invalid', () => {
    fs.writeFileSync(testAgentConfigPath, '{not-json');

    const result = resolveAgentExecutionConfig({
      source: 'chat',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.scope).toBe('global');
    }
  });

  it('rejects invalid group agent config only for that group', () => {
    const result = resolveAgentExecutionConfig({
      source: 'chat',
      group: {
        name: 'g',
        folder: 'main',
        trigger: '@a',
        added_at: '2026-01-01T00:00:00.000Z',
        containerConfig: {
          agentConfig: {
            bySource: {
              chat: {
                reasoningEffort: 'broken',
              } as any,
            },
          },
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.scope).toBe('group');
    }
  });

  it('rejects invalid task override immediately', () => {
    const result = resolveAgentExecutionConfig({
      source: 'scheduled',
      taskOverride: {
        reasoningEffort: 'wrong',
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.scope).toBe('task');
    }
  });
});
