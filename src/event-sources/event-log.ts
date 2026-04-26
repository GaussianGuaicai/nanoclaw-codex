import path from 'path';

import { LOGS_DIR } from '../config.js';
import { logger } from '../logger.js';
import {
  appendManagedJsonLine,
  WEBSOCKET_EVENT_LOG_MAX_ARCHIVES,
  WEBSOCKET_EVENT_LOG_MAX_BYTES,
} from '../log-maintenance.js';
import { formatLocalIsoTimestamp } from '../time.js';
import {
  NormalizedWebSocketEvent,
  WebSocketSubscriptionConfig,
} from '../types.js';

export interface WebSocketEventLogEntry {
  receivedAt: string;
  occurredAt: string;
  provider: string;
  connectionName: string;
  subscriptionId: string;
  targetJid: string;
  eventType: string;
  status: 'filtered' | 'cooldown' | 'logged' | 'dispatched' | 'dispatch_error';
  error?: string;
  payload: Record<string, unknown>;
}

export interface WebSocketEventLogMetadata {
  error?: string;
}

export function getWebSocketEventLogPath(provider: string): string {
  const safeProvider = provider
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const providerSegment = safeProvider || 'unknown';
  return path.join(LOGS_DIR, `websocket-events-${providerSegment}.log`);
}

export function appendWebSocketEventLog(
  event: NormalizedWebSocketEvent,
  subscription: WebSocketSubscriptionConfig,
  status: WebSocketEventLogEntry['status'],
  metadata: WebSocketEventLogMetadata = {},
): void {
  const logPath = getWebSocketEventLogPath(event.provider);
  const entry: WebSocketEventLogEntry = {
    receivedAt: formatLocalIsoTimestamp(),
    occurredAt: event.occurredAt,
    provider: event.provider,
    connectionName: event.connectionName,
    subscriptionId: subscription.id,
    targetJid: subscription.targetJid,
    eventType: event.eventType,
    status,
    ...(metadata.error ? { error: metadata.error } : {}),
    payload: event.payload,
  };

  try {
    appendManagedJsonLine(
      logPath,
      JSON.stringify(entry),
      WEBSOCKET_EVENT_LOG_MAX_BYTES,
      WEBSOCKET_EVENT_LOG_MAX_ARCHIVES,
    );
  } catch (err) {
    logger.warn({ err, path: logPath }, 'Failed to append WebSocket event log');
  }
}
