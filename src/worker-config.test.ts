import fs from 'fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { testGroupsDir } = vi.hoisted(() => ({
  testGroupsDir: '/tmp/nanoclaw-worker-config-groups',
}));

vi.mock('./config.js', () => ({
  AGENT_CONFIG_PATH: '/tmp/nanoclaw-worker-config-agent.json',
  GROUPS_DIR: testGroupsDir,
  DATA_DIR: '/tmp/nanoclaw-worker-config-data',
}));

vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { loadWorkerConfig, startWorkerConfigWatcher } from './worker-config.js';

describe('worker-owned config', () => {
  beforeEach(() => {
    fs.rmSync(testGroupsDir, { recursive: true, force: true });
  });

  afterEach(() => {
    fs.rmSync(testGroupsDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it('rejects unknown keys in worker-config.json', () => {
    fs.mkdirSync(`${testGroupsDir}/slack_main/config`, { recursive: true });
    fs.writeFileSync(
      `${testGroupsDir}/slack_main/config/worker-config.json`,
      JSON.stringify({
        websocketSubscriptions: {},
      }),
    );

    expect(loadWorkerConfig('slack_main')).toBeNull();
  });

  it('watches worker-owned config file changes', async () => {
    vi.useFakeTimers();
    fs.mkdirSync(`${testGroupsDir}/slack_main/config`, { recursive: true });
    const onChange = vi.fn(async () => {});

    const stop = startWorkerConfigWatcher({
      registeredGroups: () => ({
        'slack:main': {
          name: 'Main',
          folder: 'slack_main',
          trigger: '@Andy',
          added_at: '2026-01-01T00:00:00.000Z',
        },
      }),
      onChange,
      pollMs: 1000,
    });

    fs.writeFileSync(
      `${testGroupsDir}/slack_main/config/worker-config.json`,
      JSON.stringify({ agent: { defaults: { model: 'gpt-5.4-mini' } } }),
    );

    await vi.advanceTimersByTimeAsync(1000);
    expect(onChange).toHaveBeenCalledTimes(1);
    stop();
  });

  it('watches group websocket source file changes', async () => {
    vi.useFakeTimers();
    fs.mkdirSync(`${testGroupsDir}/slack_main/config`, { recursive: true });
    const onChange = vi.fn(async () => {});

    const stop = startWorkerConfigWatcher({
      registeredGroups: () => ({
        'slack:main': {
          name: 'Main',
          folder: 'slack_main',
          trigger: '@Andy',
          added_at: '2026-01-01T00:00:00.000Z',
        },
      }),
      onChange,
      pollMs: 1000,
    });

    fs.writeFileSync(
      `${testGroupsDir}/slack_main/config/websocket-sources.json`,
      JSON.stringify({ subscriptions: [] }),
    );

    await vi.advanceTimersByTimeAsync(1000);
    expect(onChange).toHaveBeenCalledTimes(1);
    stop();
  });

  it('reloads when a new group appears with existing worker-owned config', async () => {
    vi.useFakeTimers();
    fs.mkdirSync(`${testGroupsDir}/later-group/config`, { recursive: true });
    fs.writeFileSync(
      `${testGroupsDir}/later-group/config/worker-config.json`,
      JSON.stringify({ agent: { defaults: { model: 'gpt-5.4-mini' } } }),
    );
    const onChange = vi.fn(async () => {});
    let includeNewGroup = false;

    const stop = startWorkerConfigWatcher({
      registeredGroups: () =>
        includeNewGroup
          ? {
              'slack:later': {
                name: 'Later',
                folder: 'later-group',
                trigger: '@Andy',
                added_at: '2026-01-01T00:00:00.000Z',
              },
            }
          : {},
      onChange,
      pollMs: 1000,
    });

    await vi.advanceTimersByTimeAsync(1000);
    includeNewGroup = true;
    await vi.advanceTimersByTimeAsync(1000);

    expect(onChange).toHaveBeenCalledTimes(1);
    stop();
  });
});
