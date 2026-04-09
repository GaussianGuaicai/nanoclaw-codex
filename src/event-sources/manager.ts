import { logger } from '../logger.js';
import { RegisteredGroup, WebSocketSubscriptionConfig } from '../types.js';
import { loadWebSocketSourcesConfig } from './config.js';
import { appendWebSocketEventLog } from './event-log.js';
import './providers.js';
import {
  createWebSocketSourceConnection,
  WebSocketSourceConnection,
} from './registry.js';
import { buildWebSocketTaskPrompt, matchesSubscription } from './template.js';

interface EventTaskRequest {
  connectionName: string;
  subscription: WebSocketSubscriptionConfig;
  prompt: string;
}

interface EventTaskResult {
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

export interface WebSocketSourceManagerOptions {
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
  runEventTask: (request: EventTaskRequest) => Promise<EventTaskResult>;
}

export class WebSocketSourceManager {
  private readonly getRegisteredGroups: () => Record<string, RegisteredGroup>;
  private readonly runEventTask: WebSocketSourceManagerOptions['runEventTask'];
  private readonly connections = new Map<string, WebSocketSourceConnection>();
  private readonly lastTriggeredAt = new Map<string, number>();

  constructor(options: WebSocketSourceManagerOptions) {
    this.getRegisteredGroups = options.getRegisteredGroups;
    this.runEventTask = options.runEventTask;
  }

  async start(): Promise<void> {
    const registeredGroups = this.getRegisteredGroups();
    const config = loadWebSocketSourcesConfig(registeredGroups);
    const subscriptionsByConnection = new Map<
      string,
      WebSocketSubscriptionConfig[]
    >();
    const seenIds = new Set<string>();

    for (const subscription of config.subscriptions) {
      if (seenIds.has(subscription.id)) {
        logger.error(
          { subscriptionId: subscription.id },
          'Skipping duplicate WS subscription id',
        );
        continue;
      }
      seenIds.add(subscription.id);

      if (!config.connections[subscription.connection]) {
        logger.error(
          {
            subscriptionId: subscription.id,
            connection: subscription.connection,
          },
          'Skipping WS subscription with unknown connection',
        );
        continue;
      }

      if (!registeredGroups[subscription.targetJid]) {
        logger.error(
          {
            subscriptionId: subscription.id,
            targetJid: subscription.targetJid,
          },
          'Skipping WS subscription with unknown target group',
        );
        continue;
      }

      const current = subscriptionsByConnection.get(subscription.connection);
      if (current) {
        current.push(subscription);
      } else {
        subscriptionsByConnection.set(subscription.connection, [subscription]);
      }
    }

    for (const [name, connectionConfig] of Object.entries(config.connections)) {
      const subscriptions = subscriptionsByConnection.get(name) || [];
      if (subscriptions.length === 0) continue;

      const connection = createWebSocketSourceConnection({
        connection: connectionConfig,
        subscriptions,
        onEvent: async (event, subscription) => {
          if (!matchesSubscription(subscription, event)) {
            if (subscription.logFilteredEvents === true) {
              appendWebSocketEventLog(event, subscription, 'filtered');
            }
            return;
          }
          if (!this.shouldTrigger(subscription)) {
            if (subscription.logCooldownEvents === true) {
              appendWebSocketEventLog(event, subscription, 'cooldown');
            }
            return;
          }

          if (subscription.runTask === false) {
            appendWebSocketEventLog(event, subscription, 'logged');
            return;
          }

          const prompt = buildWebSocketTaskPrompt(subscription, event);
          try {
            const execution = await this.runEventTask({
              connectionName: connectionConfig.name,
              subscription,
              prompt,
            });

            appendWebSocketEventLog(
              event,
              subscription,
              execution.status === 'success' ? 'dispatched' : 'dispatch_error',
              {
                ...(execution.error ? { error: execution.error } : {}),
              },
            );
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            appendWebSocketEventLog(event, subscription, 'dispatch_error', {
              error: message,
            });
            throw err;
          }
        },
      });
      if (!connection) continue;
      this.connections.set(name, connection);
      await connection.start();
    }
  }

  async stop(): Promise<void> {
    await Promise.all(
      [...this.connections.values()].map((connection) => connection.stop()),
    );
    this.connections.clear();
  }

  async reload(): Promise<void> {
    await this.stop();
    this.lastTriggeredAt.clear();
    await this.start();
  }

  private shouldTrigger(subscription: WebSocketSubscriptionConfig): boolean {
    const cooldownMs = subscription.cooldownMs;
    if (!cooldownMs || cooldownMs <= 0) return true;

    const now = Date.now();
    const last = this.lastTriggeredAt.get(subscription.id) || 0;
    if (now - last < cooldownMs) {
      return false;
    }

    this.lastTriggeredAt.set(subscription.id, now);
    return true;
  }
}
