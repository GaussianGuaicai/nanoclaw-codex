import fs from 'fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

const { testLogPath } = vi.hoisted(() => ({
  testLogPath: '/tmp/nanoclaw-test-logs/websocket-events-home_assistant.log',
}));

vi.mock('../config.js', () => ({
  LOGS_DIR: '/tmp/nanoclaw-test-logs',
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  appendWebSocketEventLog,
  getWebSocketEventLogPath,
} from './event-log.js';

describe('appendWebSocketEventLog', () => {
  afterEach(() => {
    try {
      fs.unlinkSync(testLogPath);
    } catch {
      // ignore missing file
    }
  });

  it('builds provider-specific log file names', () => {
    expect(getWebSocketEventLogPath('home_assistant')).toBe(
      '/tmp/nanoclaw-test-logs/websocket-events-home_assistant.log',
    );
    expect(getWebSocketEventLogPath('Custom Vendor')).toBe(
      '/tmp/nanoclaw-test-logs/websocket-events-custom-vendor.log',
    );
  });

  it('appends JSON lines to the dedicated WebSocket event log', () => {
    appendWebSocketEventLog(
      {
        connectionName: 'ha_main',
        subscriptionId: 'front-door',
        provider: 'home_assistant',
        eventType: 'state_changed',
        occurredAt: '2026-03-12T08:00:00.000Z',
        payload: {
          data: {
            entity_id: 'binary_sensor.front_door',
          },
        },
      },
      {
        id: 'front-door',
        connection: 'ha_main',
        kind: 'events',
        eventType: 'state_changed',
        targetJid: 'slack:C123',
        promptTemplate: 'Handle {{event_type}}',
      },
      'dispatched',
    );

    const content = fs.readFileSync(testLogPath, 'utf-8').trim();
    expect(content).not.toBe('');

    const entry = JSON.parse(content) as Record<string, unknown>;
    expect(entry.provider).toBe('home_assistant');
    expect(entry.connectionName).toBe('ha_main');
    expect(entry.subscriptionId).toBe('front-door');
    expect(entry.targetJid).toBe('slack:C123');
    expect(entry.occurredAt).toBe('2026-03-12T08:00:00.000Z');
    expect(String(entry.receivedAt)).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/,
    );
    expect(entry.eventType).toBe('state_changed');
    expect(entry.status).toBe('dispatched');
  });

  it('persists error metadata when provided', () => {
    appendWebSocketEventLog(
      {
        connectionName: 'ha_main',
        subscriptionId: 'front-door',
        provider: 'home_assistant',
        eventType: 'state_changed',
        occurredAt: '2026-03-12T08:00:00.000Z',
        payload: {
          data: {
            entity_id: 'binary_sensor.front_door',
          },
        },
      },
      {
        id: 'front-door',
        connection: 'ha_main',
        kind: 'events',
        eventType: 'state_changed',
        targetJid: 'slack:C123',
        promptTemplate: 'Handle {{event_type}}',
      },
      'dispatch_error',
      {
        error: 'Worker failed',
      },
    );

    const entry = JSON.parse(fs.readFileSync(testLogPath, 'utf-8').trim()) as {
      error?: string;
    };
    expect(entry.error).toBe('Worker failed');
  });
});
