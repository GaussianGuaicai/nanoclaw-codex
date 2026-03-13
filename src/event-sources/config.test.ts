import fs from 'fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { readEnvFileMock, testConfigPath } = vi.hoisted(() => ({
  readEnvFileMock: vi.fn(),
  testConfigPath: '/tmp/nanoclaw-websocket-sources.test.json',
}));

vi.mock('../config.js', () => ({
  WEBSOCKET_SOURCES_PATH: testConfigPath,
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
  });

  afterEach(() => {
    try {
      fs.unlinkSync(testConfigPath);
    } catch {
      // ignore missing file
    }
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
});
