import fs from 'fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { readEnvFileMock, testConfigPath, testGroupsDir } = vi.hoisted(() => ({
  readEnvFileMock: vi.fn(),
  testConfigPath: '/tmp/nanoclaw-websocket-sources.test.json',
  testGroupsDir: '/tmp/nanoclaw-websocket-groups',
}));

const testInstructionsPath =
  '/tmp/nanoclaw-websocket-task-instructions.test.md';

vi.mock('../config.js', () => ({
  WEBSOCKET_SOURCES_PATH: testConfigPath,
  AGENT_CONFIG_PATH: '/tmp/nanoclaw-websocket-agent-config.test.json',
  GROUPS_DIR: testGroupsDir,
  DATA_DIR: '/tmp/nanoclaw-websocket-data',
}));

vi.mock('../env.js', () => ({
  readEnvFile: readEnvFileMock,
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { loadWebSocketSourcesConfig } from './config.js';

describe('loadWebSocketSourcesConfig', () => {
  beforeEach(() => {
    readEnvFileMock.mockReset();
    process.env.TEST_HA_URL = '';
    process.env.TEST_HA_TOKEN = '';
    try {
      fs.unlinkSync(testConfigPath);
    } catch {
      // ignore missing file
    }
    try {
      fs.unlinkSync(testInstructionsPath);
    } catch {
      // ignore missing file
    }
    fs.rmSync(testGroupsDir, { recursive: true, force: true });
  });

  afterEach(() => {
    try {
      fs.unlinkSync(testConfigPath);
    } catch {
      // ignore missing file
    }
    try {
      fs.unlinkSync(testInstructionsPath);
    } catch {
      // ignore missing file
    }
    fs.rmSync(testGroupsDir, { recursive: true, force: true });
    delete process.env.TEST_HA_URL;
    delete process.env.TEST_HA_TOKEN;
  });

  it('returns empty config when file does not exist', () => {
    readEnvFileMock.mockReturnValue({});

    expect(loadWebSocketSourcesConfig()).toEqual({
      connections: {},
      subscriptions: [],
    });
  });

  it('loads connections from env and preserves subscriptions', () => {
    fs.writeFileSync(
      testConfigPath,
      JSON.stringify({
        connections: {
          ha_main: {
            provider: 'home_assistant',
            urlEnvVar: 'TEST_HA_URL',
            tokenEnvVar: 'TEST_HA_TOKEN',
            heartbeatIntervalMs: 5000,
          },
        },
        subscriptions: [
          {
            id: 'front-door',
            connection: 'ha_main',
            kind: 'events',
            eventType: 'state_changed',
            filters: [
              {
                path: 'data.old_state.state',
                op: 'neq',
                valueFromPath: 'data.new_state.state',
              },
            ],
            runTask: false,
            logTaskResult: true,
            targetJid: 'slack:C123',
            promptTemplate: 'Handle {{event_type}}',
          },
        ],
      }),
    );

    readEnvFileMock.mockReturnValue({
      TEST_HA_URL: 'http://127.0.0.1:8123',
      TEST_HA_TOKEN: 'secret-token',
    });

    const loaded = loadWebSocketSourcesConfig();
    expect(loaded.connections.ha_main).toMatchObject({
      name: 'ha_main',
      url: 'http://127.0.0.1:8123',
      token: 'secret-token',
      provider: 'home_assistant',
    });
    expect(loaded.subscriptions).toHaveLength(1);
    expect(loaded.subscriptions[0].filters).toEqual([
      {
        path: 'data.old_state.state',
        op: 'neq',
        valueFromPath: 'data.new_state.state',
      },
    ]);
    expect(loaded.subscriptions[0].runTask).toBe(false);
    expect(loaded.subscriptions[0].logTaskResult).toBe(true);
  });

  it('skips connections whose env values are missing', () => {
    fs.writeFileSync(
      testConfigPath,
      JSON.stringify({
        connections: {
          ha_main: {
            provider: 'home_assistant',
            urlEnvVar: 'TEST_HA_URL',
            tokenEnvVar: 'TEST_HA_TOKEN',
          },
        },
        subscriptions: [],
      }),
    );

    readEnvFileMock.mockReturnValue({
      TEST_HA_URL: 'http://127.0.0.1:8123',
    });

    expect(loadWebSocketSourcesConfig()).toEqual({
      connections: {},
      subscriptions: [],
    });
  });

  it('preserves unknown provider names for higher-level factory handling', () => {
    fs.writeFileSync(
      testConfigPath,
      JSON.stringify({
        connections: {
          vendor_main: {
            provider: 'custom_vendor',
            urlEnvVar: 'TEST_HA_URL',
            tokenEnvVar: 'TEST_HA_TOKEN',
          },
        },
        subscriptions: [],
      }),
    );

    readEnvFileMock.mockReturnValue({
      TEST_HA_URL: 'wss://example.com/events',
      TEST_HA_TOKEN: 'secret-token',
    });

    const loaded = loadWebSocketSourcesConfig();
    expect(loaded.connections.vendor_main).toMatchObject({
      name: 'vendor_main',
      provider: 'custom_vendor',
    });
  });

  it('loads task instructions from a separate host file', () => {
    fs.writeFileSync(testInstructionsPath, 'Use my quiet-hours preference.');
    fs.writeFileSync(
      testConfigPath,
      JSON.stringify({
        connections: {
          ha_main: {
            provider: 'home_assistant',
            urlEnvVar: 'TEST_HA_URL',
            tokenEnvVar: 'TEST_HA_TOKEN',
          },
        },
        subscriptions: [
          {
            id: 'front-door',
            connection: 'ha_main',
            kind: 'events',
            eventType: 'state_changed',
            taskInstructionsPath: testInstructionsPath,
            targetJid: 'slack:C123',
            promptTemplate: 'Handle {{event_type}}',
          },
        ],
      }),
    );

    readEnvFileMock.mockReturnValue({
      TEST_HA_URL: 'http://127.0.0.1:8123',
      TEST_HA_TOKEN: 'secret-token',
    });

    const loaded = loadWebSocketSourcesConfig();
    expect(loaded.subscriptions[0].taskInstructions).toBe(
      'Use my quiet-hours preference.',
    );
  });

  it('skips invalid subscriptions but keeps valid ones', () => {
    fs.writeFileSync(
      testConfigPath,
      JSON.stringify({
        connections: {
          ha_main: {
            provider: 'home_assistant',
            urlEnvVar: 'TEST_HA_URL',
            tokenEnvVar: 'TEST_HA_TOKEN',
          },
        },
        subscriptions: [
          {
            id: 'invalid-subscription',
            connection: 'ha_main',
            kind: 'events',
            eventType: 'state_changed',
            targetJid: 'slack:C123',
            promptTemplate: 'Handle {{event_type}}',
            agentConfig: {
              reasoningEffort: 'broken',
            },
          },
          {
            id: 'valid-subscription',
            connection: 'ha_main',
            kind: 'events',
            eventType: 'state_changed',
            targetJid: 'slack:C456',
            promptTemplate: 'Handle {{event_type}}',
          },
        ],
      }),
    );

    readEnvFileMock.mockReturnValue({
      TEST_HA_URL: 'http://127.0.0.1:8123',
      TEST_HA_TOKEN: 'secret-token',
    });

    const loaded = loadWebSocketSourcesConfig();
    expect(loaded.subscriptions).toHaveLength(1);
    expect(loaded.subscriptions[0].id).toBe('valid-subscription');
  });

  it('loads websocket subscriptions from the owning group directory', () => {
    fs.mkdirSync(`${testGroupsDir}/slack_main/config`, { recursive: true });
    fs.writeFileSync(
      `${testGroupsDir}/slack_main/config/websocket-sources.json`,
      JSON.stringify({
        subscriptions: [
          {
            id: 'front-door',
            connection: 'ha_main',
            eventType: 'state_changed',
            filters: [
              {
                path: 'data.entity_id',
                op: 'starts_with',
                value: 'device_tracker.',
              },
            ],
            promptTemplate: 'Handle {{event_type}}',
            contextMode: 'group',
            deliverOutput: true,
          },
        ],
      }),
    );
    fs.writeFileSync(
      testConfigPath,
      JSON.stringify({
        connections: {
          ha_main: {
            provider: 'home_assistant',
            urlEnvVar: 'TEST_HA_URL',
            tokenEnvVar: 'TEST_HA_TOKEN',
          },
        },
      }),
    );

    readEnvFileMock.mockReturnValue({
      TEST_HA_URL: 'http://127.0.0.1:8123',
      TEST_HA_TOKEN: 'secret-token',
    });

    const loaded = loadWebSocketSourcesConfig({
      'slack:C123': {
        name: 'Main',
        folder: 'slack_main',
        trigger: '@Andy',
        added_at: '2026-01-01T00:00:00.000Z',
      },
    });

    expect(loaded.subscriptions).toHaveLength(1);
    expect(loaded.subscriptions[0]).toMatchObject({
      id: 'front-door',
      kind: 'events',
      targetJid: 'slack:C123',
      contextMode: 'group',
      deliverOutput: true,
    });
  });

  it('rejects group websocket subscriptions that try to set targetJid', () => {
    fs.mkdirSync(`${testGroupsDir}/slack_main/config`, { recursive: true });
    fs.writeFileSync(
      `${testGroupsDir}/slack_main/config/websocket-sources.json`,
      JSON.stringify({
        subscriptions: [
          {
            id: 'front-door',
            connection: 'ha_main',
            eventType: 'state_changed',
            targetJid: 'slack:other',
            promptTemplate: 'Handle {{event_type}}',
          },
        ],
      }),
    );
    fs.writeFileSync(
      testConfigPath,
      JSON.stringify({
        connections: {
          ha_main: {
            provider: 'home_assistant',
            urlEnvVar: 'TEST_HA_URL',
            tokenEnvVar: 'TEST_HA_TOKEN',
          },
        },
      }),
    );

    readEnvFileMock.mockReturnValue({
      TEST_HA_URL: 'http://127.0.0.1:8123',
      TEST_HA_TOKEN: 'secret-token',
    });

    const loaded = loadWebSocketSourcesConfig({
      'slack:C123': {
        name: 'Main',
        folder: 'slack_main',
        trigger: '@Andy',
        added_at: '2026-01-01T00:00:00.000Z',
      },
    });

    expect(loaded.subscriptions).toHaveLength(0);
  });

  it('rejects group websocket subscriptions that try to read host instruction paths', () => {
    fs.mkdirSync(`${testGroupsDir}/slack_main/config`, { recursive: true });
    fs.writeFileSync(
      `${testGroupsDir}/slack_main/config/websocket-sources.json`,
      JSON.stringify({
        subscriptions: [
          {
            id: 'front-door',
            connection: 'ha_main',
            eventType: 'state_changed',
            taskInstructionsPath: '~/.config/nanoclaw/secret-notes.md',
            promptTemplate: 'Handle {{event_type}}',
          },
        ],
      }),
    );
    fs.writeFileSync(
      testConfigPath,
      JSON.stringify({
        connections: {
          ha_main: {
            provider: 'home_assistant',
            urlEnvVar: 'TEST_HA_URL',
            tokenEnvVar: 'TEST_HA_TOKEN',
          },
        },
      }),
    );

    readEnvFileMock.mockReturnValue({
      TEST_HA_URL: 'http://127.0.0.1:8123',
      TEST_HA_TOKEN: 'secret-token',
    });

    const loaded = loadWebSocketSourcesConfig({
      'slack:C123': {
        name: 'Main',
        folder: 'slack_main',
        trigger: '@Andy',
        added_at: '2026-01-01T00:00:00.000Z',
      },
    });

    expect(loaded.subscriptions).toHaveLength(0);
  });

  it('lets group-owned subscriptions override legacy host subscriptions with the same id', () => {
    fs.mkdirSync(`${testGroupsDir}/slack_main/config`, { recursive: true });
    fs.writeFileSync(
      `${testGroupsDir}/slack_main/config/websocket-sources.json`,
      JSON.stringify({
        subscriptions: [
          {
            id: 'front-door',
            connection: 'ha_main',
            eventType: 'state_changed',
            promptTemplate: 'Group-owned handler',
            deliverOutput: true,
          },
        ],
      }),
    );
    fs.writeFileSync(
      testConfigPath,
      JSON.stringify({
        connections: {
          ha_main: {
            provider: 'home_assistant',
            urlEnvVar: 'TEST_HA_URL',
            tokenEnvVar: 'TEST_HA_TOKEN',
          },
        },
        subscriptions: [
          {
            id: 'front-door',
            connection: 'ha_main',
            kind: 'events',
            eventType: 'state_changed',
            targetJid: 'slack:legacy',
            promptTemplate: 'Legacy handler',
          },
        ],
      }),
    );

    readEnvFileMock.mockReturnValue({
      TEST_HA_URL: 'http://127.0.0.1:8123',
      TEST_HA_TOKEN: 'secret-token',
    });

    const loaded = loadWebSocketSourcesConfig({
      'slack:C123': {
        name: 'Main',
        folder: 'slack_main',
        trigger: '@Andy',
        added_at: '2026-01-01T00:00:00.000Z',
      },
    });

    expect(loaded.subscriptions).toHaveLength(1);
    expect(loaded.subscriptions[0]).toMatchObject({
      id: 'front-door',
      targetJid: 'slack:C123',
      promptTemplate: 'Group-owned handler',
      deliverOutput: true,
    });
  });
});
