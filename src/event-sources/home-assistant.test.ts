import { EventEmitter } from 'events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { HomeAssistantConnection } from './home-assistant.js';

class FakeWebSocket extends EventEmitter {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close');
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open');
  }

  receive(payload: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(payload)));
  }
}

describe('HomeAssistantConnection', () => {
  let socket: FakeWebSocket;

  beforeEach(() => {
    socket = new FakeWebSocket();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('authenticates, subscribes, and forwards events', async () => {
    const onEvent = vi.fn();
    const eventReceived = new Promise<void>((resolve) => {
      onEvent.mockImplementation(() => resolve());
    });

    const connection = new HomeAssistantConnection({
      connection: {
        name: 'ha_main',
        provider: 'home_assistant',
        url: 'http://127.0.0.1:8123',
        token: 'secret-token',
        urlEnvVar: 'TEST_HA_URL',
        tokenEnvVar: 'TEST_HA_TOKEN',
        features: { coalesceMessages: true },
      },
      subscriptions: [
        {
          id: 'kitchen-light',
          connection: 'ha_main',
          kind: 'events',
          eventType: 'state_changed',
          targetJid: 'slack:C123',
          promptTemplate: 'Handle {{event_type}}',
        },
      ],
      onEvent,
      websocketFactory: () => socket as any,
    });

    await connection.start();

    socket.open();
    socket.receive({ type: 'auth_required', ha_version: '2026.3.0' });
    expect(JSON.parse(socket.sent[0])).toEqual({
      type: 'auth',
      access_token: 'secret-token',
    });

    socket.receive({ type: 'auth_ok', ha_version: '2026.3.0' });
    await Promise.resolve();
    expect(JSON.parse(socket.sent[1])).toMatchObject({
      id: 1,
      type: 'supported_features',
      features: { coalesce_messages: 1 },
    });

    socket.receive({ id: 1, type: 'result', success: true, result: null });
    await Promise.resolve();
    expect(JSON.parse(socket.sent[2])).toMatchObject({
      id: 2,
      type: 'subscribe_events',
      event_type: 'state_changed',
    });

    socket.receive({ id: 2, type: 'result', success: true, result: null });
    socket.receive({
      id: 2,
      type: 'event',
      event: {
        event_type: 'state_changed',
        time_fired: '2026-03-12T08:00:00.000Z',
        data: {
          entity_id: 'light.kitchen',
          new_state: { state: 'on' },
        },
      },
    });

    await eventReceived;

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionName: 'ha_main',
        eventType: 'state_changed',
        occurredAt: '2026-03-12T08:00:00.000Z',
      }),
      expect.objectContaining({ id: 'kitchen-light' }),
    );

    await connection.stop();
  });

  it('sends heartbeat pings after subscribing', async () => {
    vi.useFakeTimers();

    const connection = new HomeAssistantConnection({
      connection: {
        name: 'ha_main',
        provider: 'home_assistant',
        url: 'http://127.0.0.1:8123',
        token: 'secret-token',
        urlEnvVar: 'TEST_HA_URL',
        tokenEnvVar: 'TEST_HA_TOKEN',
        heartbeatIntervalMs: 25,
      },
      subscriptions: [
        {
          id: 'heartbeat',
          connection: 'ha_main',
          kind: 'events',
          eventType: 'state_changed',
          targetJid: 'slack:C123',
          promptTemplate: 'Handle {{event_type}}',
        },
      ],
      onEvent: vi.fn(),
      websocketFactory: () => socket as any,
    });

    await connection.start();
    socket.open();
    socket.receive({ type: 'auth_required', ha_version: '2026.3.0' });
    socket.receive({ type: 'auth_ok', ha_version: '2026.3.0' });
    await Promise.resolve();
    socket.receive({ id: 1, type: 'result', success: true, result: null });
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(30);

    const pingMessage = socket.sent
      .map((value) => JSON.parse(value) as Record<string, unknown>)
      .find((message) => message.type === 'ping');

    expect(pingMessage).toMatchObject({
      id: 2,
      type: 'ping',
    });

    socket.receive({ id: 2, type: 'pong' });
    await connection.stop();
  });
});
