import { logger } from '../logger.js';
import {
  NormalizedWebSocketEvent,
  WebSocketSubscriptionConfig,
} from '../types.js';
import { ResolvedWebSocketConnectionConfig } from './config.js';
import {
  ManagedWebSocketConnection,
  ManagedWebSocketConnectionOptions,
} from './base.js';
import { registerWebSocketProvider } from './registry.js';

export interface HomeAssistantConnectionOptions extends ManagedWebSocketConnectionOptions {
  connection: ResolvedWebSocketConnectionConfig;
  subscriptions: WebSocketSubscriptionConfig[];
  onEvent: (
    event: NormalizedWebSocketEvent,
    subscription: WebSocketSubscriptionConfig,
  ) => Promise<void> | void;
}

export class HomeAssistantConnection extends ManagedWebSocketConnection {
  private readonly subscriptions: WebSocketSubscriptionConfig[];
  private readonly onEvent: HomeAssistantConnectionOptions['onEvent'];
  private readonly activeSubscriptions = new Map<
    number,
    WebSocketSubscriptionConfig
  >();

  constructor(options: HomeAssistantConnectionOptions) {
    super(options);
    this.subscriptions = options.subscriptions;
    this.onEvent = options.onEvent;
  }

  async sendCommand(command: Record<string, unknown>): Promise<unknown> {
    return this.sendRequest(command, 'result');
  }

  protected override onDisconnected(): void {
    this.activeSubscriptions.clear();
  }

  protected override handleParsedMessage(parsed: unknown): void {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;

    const message = parsed as Record<string, unknown>;
    const type = message.type;

    if (type === 'auth_required') {
      this.sendJson({
        type: 'auth',
        access_token: this.connection.token,
      });
      return;
    }

    if (type === 'auth_ok') {
      this.markConnected();
      void this.afterAuth();
      return;
    }

    if (type === 'auth_invalid') {
      logger.error(
        { ...this.logContext(), message: message.message },
        'Home Assistant WS auth failed',
      );
      this.closeSocket();
      return;
    }

    const id = typeof message.id === 'number' ? message.id : undefined;
    if (type === 'result' && id !== undefined) {
      const pending = this.consumePendingRequest(id, 'result');
      if (!pending) return;

      if (message.success === true) {
        if (pending.subscription) {
          this.activeSubscriptions.set(id, pending.subscription);
        }
        pending.resolve(message.result ?? null);
        return;
      }

      const errorMessage =
        typeof message.error === 'object' &&
        message.error &&
        'message' in message.error
          ? String((message.error as { message: unknown }).message)
          : 'Unknown Home Assistant command error';
      pending.reject(new Error(errorMessage));
      return;
    }

    if (type === 'pong' && id !== undefined) {
      const pending = this.consumePendingRequest(id, 'pong');
      if (!pending) return;
      pending.resolve(null);
      return;
    }

    if (type === 'event' && id !== undefined) {
      const subscription = this.activeSubscriptions.get(id);
      if (!subscription) return;

      const event = this.normalizeEvent(subscription, message.event);
      if (!event) return;

      void Promise.resolve(this.onEvent(event, subscription)).catch((err) => {
        logger.error(
          {
            ...this.logContext(),
            subscriptionId: subscription.id,
            err,
          },
          'Home Assistant event handler failed',
        );
      });
    }
  }

  protected override normalizeUrl(rawUrl: string): string {
    const url = new URL(rawUrl);

    if (!url.pathname || url.pathname === '/') {
      url.pathname = '/api/websocket';
    } else if (!url.pathname.endsWith('/api/websocket')) {
      url.pathname = `${url.pathname.replace(/\/$/, '')}/api/websocket`;
    }

    if (url.protocol === 'http:') {
      url.protocol = 'ws:';
    } else if (url.protocol === 'https:') {
      url.protocol = 'wss:';
    }

    return url.toString();
  }

  private normalizeEvent(
    subscription: WebSocketSubscriptionConfig,
    payload: unknown,
  ): NormalizedWebSocketEvent | null {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return null;
    }

    const event = payload as Record<string, unknown>;
    return {
      connectionName: this.connection.name,
      subscriptionId: subscription.id,
      provider: this.connection.provider,
      eventType:
        typeof event.event_type === 'string'
          ? event.event_type
          : subscription.eventType,
      occurredAt:
        typeof event.time_fired === 'string'
          ? event.time_fired
          : new Date().toISOString(),
      payload: event,
    };
  }

  private async afterAuth(): Promise<void> {
    try {
      if (this.connection.features?.coalesceMessages) {
        await this.sendRequest(
          {
            type: 'supported_features',
            features: { coalesce_messages: 1 },
          },
          'result',
        );
      }

      for (const subscription of this.subscriptions) {
        await this.sendRequest(
          {
            type: 'subscribe_events',
            event_type: subscription.eventType,
          },
          'result',
          subscription,
        );
      }

      this.startHeartbeatLoop({
        intervalMs: this.connection.heartbeatIntervalMs ?? 30000,
        buildPayload: () => ({ type: 'ping' }),
        expectedType: 'pong',
        failureLogMessage: 'Home Assistant ping failed, reconnecting',
      });

      logger.info(
        {
          ...this.logContext(),
          subscriptions: this.subscriptions.length,
        },
        'Home Assistant WS subscriptions active',
      );
    } catch (err) {
      logger.error(
        { ...this.logContext(), err },
        'Home Assistant WS setup failed',
      );
      this.closeSocket();
    }
  }
}

registerWebSocketProvider(
  'home_assistant',
  (options) => new HomeAssistantConnection(options),
);
