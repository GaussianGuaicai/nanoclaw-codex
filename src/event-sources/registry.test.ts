import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  _resetWebSocketProviderRegistryForTests,
  createWebSocketSourceConnection,
  listRegisteredWebSocketProviders,
  registerWebSocketProvider,
} from './registry.js';

describe('WebSocket provider registry', () => {
  afterEach(() => {
    _resetWebSocketProviderRegistryForTests();
    vi.resetModules();
  });

  it('creates connections from registered factories', () => {
    const factory = vi.fn().mockReturnValue({
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    });

    registerWebSocketProvider('custom_vendor', factory);

    const connection = createWebSocketSourceConnection({
      connection: {
        name: 'vendor_main',
        provider: 'custom_vendor',
        url: 'wss://example.com/events',
        token: 'secret',
        urlEnvVar: 'TEST_WS_URL',
        tokenEnvVar: 'TEST_WS_TOKEN',
      },
      subscriptions: [],
      onEvent: vi.fn(),
    });

    expect(connection).not.toBeNull();
    expect(factory).toHaveBeenCalledOnce();
    expect(listRegisteredWebSocketProviders()).toContain('custom_vendor');
  });

  it('self-registers built-in providers through the provider barrel', async () => {
    vi.resetModules();
    const registry = await import('./registry.js');
    registry._resetWebSocketProviderRegistryForTests();
    await import('./providers.js');

    expect(registry.listRegisteredWebSocketProviders()).toContain(
      'home_assistant',
    );
  });
});
