import WebSocket from 'ws';

import { logger } from '../logger.js';
import { WebSocketSubscriptionConfig } from '../types.js';
import { ResolvedWebSocketConnectionConfig } from './config.js';

export interface PendingRequest {
  expectedType: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  subscription?: WebSocketSubscriptionConfig;
}

export interface ManagedWebSocketConnectionOptions {
  connection: ResolvedWebSocketConnectionConfig;
  websocketFactory?: (url: string) => WebSocket;
}

export abstract class ManagedWebSocketConnection {
  protected readonly connection: ResolvedWebSocketConnectionConfig;
  protected readonly websocketFactory: (url: string) => WebSocket;

  protected socket: WebSocket | null = null;
  private connected = false;
  private stopped = false;
  private nextRequestId = 1;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly pendingRequests = new Map<number, PendingRequest>();

  constructor(options: ManagedWebSocketConnectionOptions) {
    this.connection = options.connection;
    this.websocketFactory =
      options.websocketFactory ||
      ((url: string) => new WebSocket(this.normalizeUrl(url)));
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.connected = false;
    this.clearReconnectTimer();
    this.clearHeartbeatTimer();
    this.rejectPending('Connection stopped');
    this.onDisconnected();

    const socket = this.socket;
    this.socket = null;
    if (!socket) return;

    socket.removeAllListeners();
    if (
      socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING
    ) {
      socket.close();
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  protected markConnected(): void {
    this.connected = true;
    this.reconnectAttempt = 0;
  }

  protected closeSocket(): void {
    this.socket?.close();
  }

  protected sendRequest(
    payload: Record<string, unknown>,
    expectedType: string,
    subscription?: WebSocketSubscriptionConfig,
  ): Promise<unknown> {
    const id = this.nextRequestId++;
    const request = { ...payload, id };
    const timeoutMs = this.connection.requestTimeoutMs ?? 10000;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`WS request timed out: ${String(payload.type)}`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        expectedType,
        resolve,
        reject,
        timeout,
        subscription,
      });

      try {
        this.sendJson(request);
      } catch (err) {
        clearTimeout(timeout);
        this.pendingRequests.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  protected consumePendingRequest(
    id: number,
    expectedType: string,
  ): PendingRequest | undefined {
    const pending = this.pendingRequests.get(id);
    if (!pending || pending.expectedType !== expectedType) {
      return undefined;
    }

    this.pendingRequests.delete(id);
    clearTimeout(pending.timeout);
    return pending;
  }

  protected rejectPending(message: string): void {
    for (const [id, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(message));
      this.pendingRequests.delete(id);
    }
  }

  protected startHeartbeatLoop(options: {
    intervalMs?: number;
    buildPayload: () => Record<string, unknown>;
    expectedType: string;
    failureLogMessage: string;
  }): void {
    this.clearHeartbeatTimer();
    this.heartbeatTimer = setInterval(() => {
      void this.sendRequest(options.buildPayload(), options.expectedType).catch(
        (err) => {
          logger.warn({ ...this.logContext(), err }, options.failureLogMessage);
          this.closeSocket();
        },
      );
    }, options.intervalMs ?? 30000);
  }

  protected clearHeartbeatLoop(): void {
    this.clearHeartbeatTimer();
  }

  protected sendJson(payload: Record<string, unknown>): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WS socket is not open');
    }
    this.socket.send(JSON.stringify(payload));
  }

  protected normalizeUrl(rawUrl: string): string {
    return rawUrl;
  }

  protected onDisconnected(): void {
    // Default no-op; subclasses can clear provider-specific state.
  }

  protected logContext(): Record<string, unknown> {
    return {
      provider: this.connection.provider,
      connection: this.connection.name,
    };
  }

  private connect(): void {
    if (this.stopped) return;

    try {
      this.socket = this.websocketFactory(this.connection.url);
    } catch (err) {
      logger.error({ ...this.logContext(), err }, 'Failed to create WS client');
      this.scheduleReconnect();
      return;
    }

    this.connected = false;
    this.onDisconnected();

    this.socket.on('open', () => {
      logger.info(this.logContext(), 'WS socket opened');
    });

    this.socket.on('message', (data) => {
      this.handleRawMessage(data.toString());
    });

    this.socket.on('close', () => {
      logger.warn(this.logContext(), 'WS socket closed');
      this.connected = false;
      this.clearHeartbeatTimer();
      this.rejectPending('Socket closed');
      this.onDisconnected();
      this.scheduleReconnect();
    });

    this.socket.on('error', (err) => {
      logger.error({ ...this.logContext(), err }, 'WS socket error');
    });
  }

  private handleRawMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      logger.warn(
        { ...this.logContext(), err, raw },
        'Ignoring invalid WS JSON payload',
      );
      return;
    }

    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        this.handleParsedMessage(item);
      }
      return;
    }

    this.handleParsedMessage(parsed);
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;

    const initialDelayMs = this.connection.reconnect?.initialDelayMs ?? 1000;
    const maxDelayMs = this.connection.reconnect?.maxDelayMs ?? 30000;
    const delayMs = Math.min(
      initialDelayMs * 2 ** this.reconnectAttempt,
      maxDelayMs,
    );
    this.reconnectAttempt += 1;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearHeartbeatTimer(): void {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  protected abstract handleParsedMessage(parsed: unknown): void;
}
