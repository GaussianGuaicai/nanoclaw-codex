import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NormalizedWebSocketEvent } from '../types.js';

const { loadConfigMock, connectionInstances } = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  connectionInstances: [] as Array<{
    options: any;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }>,
}));
const { appendEventLogMock } = vi.hoisted(() => ({
  appendEventLogMock: vi.fn(),
}));
const { createConnectionMock } = vi.hoisted(() => ({
  createConnectionMock: vi.fn(),
}));

vi.mock('./config.js', () => ({
  loadWebSocketSourcesConfig: loadConfigMock,
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('./event-log.js', () => ({
  appendWebSocketEventLog: appendEventLogMock,
}));

vi.mock('./registry.js', () => ({
  createWebSocketSourceConnection: createConnectionMock,
}));

vi.mock('./providers.js', () => ({}));

import { WebSocketSourceManager } from './manager.js';

describe('WebSocketSourceManager', () => {
  beforeEach(() => {
    loadConfigMock.mockReset();
    connectionInstances.length = 0;
    appendEventLogMock.mockReset();
    createConnectionMock.mockReset();
    createConnectionMock.mockImplementation((options: any) => {
      const connection = {
        options,
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
      };
      connectionInstances.push(connection);
      return connection;
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts only valid subscriptions and only logs dispatched events by default', async () => {
    loadConfigMock.mockReturnValue({
      connections: {
        ha_main: {
          name: 'ha_main',
          provider: 'home_assistant',
          url: 'http://127.0.0.1:8123',
          token: 'secret',
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
          match: { 'data.entity_id': 'binary_sensor.front_door' },
          targetJid: 'slack:C123',
          promptTemplate: 'Handle {{event_type}}',
          cooldownMs: 1000,
        },
        {
          id: 'unknown-group',
          connection: 'ha_main',
          kind: 'events',
          eventType: 'state_changed',
          targetJid: 'slack:C999',
          promptTemplate: 'Ignored',
        },
      ],
    });

    const runEventTask = vi.fn().mockResolvedValue({
      status: 'success',
      result: null,
      error: null,
    });
    const manager = new WebSocketSourceManager({
      getRegisteredGroups: () => ({
        'slack:C123': {
          name: 'Ops',
          folder: 'slack_ops',
          trigger: '@Andy',
          added_at: '2026-03-12T00:00:00.000Z',
        },
      }),
      runEventTask,
    });

    await manager.start();

    expect(connectionInstances).toHaveLength(1);
    expect(connectionInstances[0].options.subscriptions).toHaveLength(1);

    const event: NormalizedWebSocketEvent = {
      connectionName: 'ha_main',
      subscriptionId: 'front-door',
      provider: 'home_assistant',
      eventType: 'state_changed',
      occurredAt: '2026-03-12T08:00:00.000Z',
      payload: {
        event_type: 'state_changed',
        data: {
          entity_id: 'binary_sensor.front_door',
        },
      },
    };

    await connectionInstances[0].options.onEvent(
      event,
      connectionInstances[0].options.subscriptions[0],
    );
    await connectionInstances[0].options.onEvent(
      event,
      connectionInstances[0].options.subscriptions[0],
    );

    expect(runEventTask).toHaveBeenCalledTimes(1);
    expect(runEventTask).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionName: 'ha_main',
        prompt: 'Handle state_changed',
      }),
    );
    expect(appendEventLogMock).toHaveBeenCalledTimes(1);
    expect(appendEventLogMock).toHaveBeenNthCalledWith(
      1,
      event,
      connectionInstances[0].options.subscriptions[0],
      'dispatched',
      {},
    );

    await vi.advanceTimersByTimeAsync(1001);

    await connectionInstances[0].options.onEvent(
      event,
      connectionInstances[0].options.subscriptions[0],
    );

    expect(runEventTask).toHaveBeenCalledTimes(2);
    expect(appendEventLogMock).toHaveBeenCalledTimes(2);
    expect(appendEventLogMock).toHaveBeenNthCalledWith(
      2,
      event,
      connectionInstances[0].options.subscriptions[0],
      'dispatched',
      {},
    );

    await manager.stop();
    expect(connectionInstances[0].stop).toHaveBeenCalled();
  });

  it('can opt in to filtered and cooldown event logging', async () => {
    loadConfigMock.mockReturnValue({
      connections: {
        ha_main: {
          name: 'ha_main',
          provider: 'home_assistant',
          url: 'http://127.0.0.1:8123',
          token: 'secret',
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
          match: { 'data.entity_id': 'binary_sensor.front_door' },
          targetJid: 'slack:C123',
          promptTemplate: 'Handle {{event_type}}',
          cooldownMs: 1000,
          logFilteredEvents: true,
          logCooldownEvents: true,
        },
      ],
    });

    const manager = new WebSocketSourceManager({
      getRegisteredGroups: () => ({
        'slack:C123': {
          name: 'Ops',
          folder: 'slack_ops',
          trigger: '@Andy',
          added_at: '2026-03-12T00:00:00.000Z',
        },
      }),
      runEventTask: vi.fn().mockResolvedValue({
        status: 'success',
        result: null,
        error: null,
      }),
    });

    await manager.start();

    const subscription = connectionInstances[0].options.subscriptions[0];

    await connectionInstances[0].options.onEvent(
      {
        connectionName: 'ha_main',
        subscriptionId: 'front-door',
        provider: 'home_assistant',
        eventType: 'state_changed',
        occurredAt: '2026-03-12T08:00:00.000Z',
        payload: {
          event_type: 'state_changed',
          data: { entity_id: 'sensor.temperature' },
        },
      },
      subscription,
    );

    await connectionInstances[0].options.onEvent(
      {
        connectionName: 'ha_main',
        subscriptionId: 'front-door',
        provider: 'home_assistant',
        eventType: 'state_changed',
        occurredAt: '2026-03-12T08:00:01.000Z',
        payload: {
          event_type: 'state_changed',
          data: { entity_id: 'binary_sensor.front_door' },
        },
      },
      subscription,
    );

    await connectionInstances[0].options.onEvent(
      {
        connectionName: 'ha_main',
        subscriptionId: 'front-door',
        provider: 'home_assistant',
        eventType: 'state_changed',
        occurredAt: '2026-03-12T08:00:02.000Z',
        payload: {
          event_type: 'state_changed',
          data: { entity_id: 'binary_sensor.front_door' },
        },
      },
      subscription,
    );

    expect(appendEventLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          data: expect.objectContaining({ entity_id: 'sensor.temperature' }),
        }),
      }),
      subscription,
      'filtered',
    );
    expect(appendEventLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          data: expect.objectContaining({
            entity_id: 'binary_sensor.front_door',
          }),
        }),
      }),
      subscription,
      'cooldown',
    );
  });

  it('can log events without running tasks', async () => {
    loadConfigMock.mockReturnValue({
      connections: {
        ha_main: {
          name: 'ha_main',
          provider: 'home_assistant',
          url: 'http://127.0.0.1:8123',
          token: 'secret',
          urlEnvVar: 'TEST_HA_URL',
          tokenEnvVar: 'TEST_HA_TOKEN',
        },
      },
      subscriptions: [
        {
          id: 'log-only',
          connection: 'ha_main',
          kind: 'events',
          eventType: 'state_changed',
          runTask: false,
          targetJid: 'slack:C123',
          promptTemplate: 'Handle {{event_type}}',
        },
      ],
    });

    const runEventTask = vi.fn().mockResolvedValue({
      status: 'success',
      result: null,
      error: null,
    });
    const manager = new WebSocketSourceManager({
      getRegisteredGroups: () => ({
        'slack:C123': {
          name: 'Ops',
          folder: 'slack_ops',
          trigger: '@Andy',
          added_at: '2026-03-12T00:00:00.000Z',
        },
      }),
      runEventTask,
    });

    await manager.start();

    const subscription = connectionInstances[0].options.subscriptions[0];
    const event: NormalizedWebSocketEvent = {
      connectionName: 'ha_main',
      subscriptionId: 'log-only',
      provider: 'home_assistant',
      eventType: 'state_changed',
      occurredAt: '2026-03-12T08:00:00.000Z',
      payload: {
        event_type: 'state_changed',
        data: { entity_id: 'sensor.temperature' },
      },
    };

    await connectionInstances[0].options.onEvent(event, subscription);

    expect(runEventTask).not.toHaveBeenCalled();
    expect(appendEventLogMock).toHaveBeenCalledWith(
      event,
      subscription,
      'logged',
    );
  });

  it('can include task results in event logs when enabled', async () => {
    loadConfigMock.mockReturnValue({
      connections: {
        ha_main: {
          name: 'ha_main',
          provider: 'home_assistant',
          url: 'http://127.0.0.1:8123',
          token: 'secret',
          urlEnvVar: 'TEST_HA_URL',
          tokenEnvVar: 'TEST_HA_TOKEN',
        },
      },
      subscriptions: [
        {
          id: 'task-result',
          connection: 'ha_main',
          kind: 'events',
          eventType: 'state_changed',
          logTaskResult: true,
          targetJid: 'slack:C123',
          promptTemplate: 'Handle {{event_type}}',
        },
      ],
    });

    const runEventTask = vi.fn().mockResolvedValue({
      status: 'success',
      result: 'Need to notify user about this change.',
      error: null,
    });
    const manager = new WebSocketSourceManager({
      getRegisteredGroups: () => ({
        'slack:C123': {
          name: 'Ops',
          folder: 'slack_ops',
          trigger: '@Andy',
          added_at: '2026-03-12T00:00:00.000Z',
        },
      }),
      runEventTask,
    });

    await manager.start();

    const subscription = connectionInstances[0].options.subscriptions[0];
    const event: NormalizedWebSocketEvent = {
      connectionName: 'ha_main',
      subscriptionId: 'task-result',
      provider: 'home_assistant',
      eventType: 'state_changed',
      occurredAt: '2026-03-12T08:00:00.000Z',
      payload: {
        event_type: 'state_changed',
        data: { entity_id: 'switch.gaussian_pc' },
      },
    };

    await connectionInstances[0].options.onEvent(event, subscription);

    expect(appendEventLogMock).toHaveBeenCalledWith(
      event,
      subscription,
      'dispatched',
      {},
    );
  });

  it('skips unsupported providers without constructing a connection', async () => {
    loadConfigMock.mockReturnValue({
      connections: {
        generic: {
          name: 'generic',
          provider: 'custom_vendor',
          url: 'wss://example.com/events',
          token: 'secret',
          urlEnvVar: 'TEST_WS_URL',
          tokenEnvVar: 'TEST_WS_TOKEN',
        },
      },
      subscriptions: [
        {
          id: 'custom-events',
          connection: 'generic',
          kind: 'events',
          eventType: 'custom.event',
          targetJid: 'slack:C123',
          promptTemplate: 'Handle {{event_type}}',
        },
      ],
    });

    createConnectionMock.mockReturnValueOnce(null);

    const manager = new WebSocketSourceManager({
      getRegisteredGroups: () => ({
        'slack:C123': {
          name: 'Ops',
          folder: 'slack_ops',
          trigger: '@Andy',
          added_at: '2026-03-12T00:00:00.000Z',
        },
      }),
      runEventTask: vi.fn().mockResolvedValue({
        status: 'success',
        result: null,
        error: null,
      }),
    });

    await manager.start();

    expect(connectionInstances).toHaveLength(0);
    expect(createConnectionMock).toHaveBeenCalledTimes(1);
  });
});
