import { logger } from '../logger.js';
import {
  NormalizedWebSocketEvent,
  WebSocketSubscriptionConfig,
} from '../types.js';
import { ResolvedWebSocketConnectionConfig } from './config.js';

export interface WebSocketSourceConnection {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface CreateWebSocketSourceConnectionOptions {
  connection: ResolvedWebSocketConnectionConfig;
  subscriptions: WebSocketSubscriptionConfig[];
  onEvent: (
    event: NormalizedWebSocketEvent,
    subscription: WebSocketSubscriptionConfig,
  ) => Promise<void> | void;
}

export type WebSocketProviderFactory = (
  options: CreateWebSocketSourceConnectionOptions,
) => WebSocketSourceConnection;

const providerRegistry = new Map<string, WebSocketProviderFactory>();

export function registerWebSocketProvider(
  provider: string,
  factory: WebSocketProviderFactory,
): void {
  providerRegistry.set(provider, factory);
}

export function createWebSocketSourceConnection(
  options: CreateWebSocketSourceConnectionOptions,
): WebSocketSourceConnection | null {
  const factory = providerRegistry.get(options.connection.provider);
  if (!factory) {
    logger.error(
      {
        connection: options.connection.name,
        provider: options.connection.provider,
      },
      'Skipping unsupported WS provider',
    );
    return null;
  }

  return factory(options);
}

export function listRegisteredWebSocketProviders(): string[] {
  return [...providerRegistry.keys()];
}

export function _resetWebSocketProviderRegistryForTests(): void {
  providerRegistry.clear();
}
