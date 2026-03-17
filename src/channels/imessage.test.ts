import { describe, expect, it, vi, beforeEach } from 'vitest';

import type {
  IMessageAdapter,
  IMessageInboundEvent,
} from './imessage/adapters/types.js';
import type { IMessageBackendConfig } from './imessage/imessage-config.js';

const registerChannelMock = vi.hoisted(() => vi.fn());
const readEnvFileMock = vi.hoisted(() => vi.fn());

vi.mock('./registry.js', () => ({
  registerChannel: registerChannelMock,
}));

vi.mock('../env.js', () => ({
  readEnvFile: readEnvFileMock,
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

class FakeAdapter implements IMessageAdapter {
  inboundHandler: ((event: IMessageInboundEvent) => void) | null = null;
  sent: Array<{ chatId: string; text: string }> = [];

  async connect(): Promise<void> {}

  async subscribeInbound(
    handler: (event: IMessageInboundEvent) => void,
  ): Promise<void> {
    this.inboundHandler = handler;
  }

  async send(chatId: string, text: string): Promise<void> {
    this.sent.push({ chatId, text });
  }

  async resolveChatMeta(): Promise<{
    name?: string;
    isGroup?: boolean;
  } | null> {
    return { name: 'Test Chat', isGroup: true };
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}

function createConfig(
  overrides: Partial<IMessageBackendConfig> = {},
): IMessageBackendConfig {
  return {
    enabled: true,
    rolloutStage: 3,
    allowedChatIds: [],
    backend: 'bluebubbles',
    fallbackBackend: null,
    account: 'me@example.com',
    allowedHosts: [],
    allowInsecureHttp: false,
    reconnect: { initialDelayMs: 10, maxDelayMs: 100 },
    send: { rateLimitPerSecond: 1000, queueMaxSize: 50 },
    blueBubbles: { url: 'http://localhost:1234', password: 'secret' },
    smserver: { url: '' },
    riskyMode: { enableDirectChatDb: false, confirmed: false },
    ...overrides,
  };
}

function createOpts() {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'im:iMessage;+;chat123': {
        name: 'Registered Chat',
        folder: 'imessage-main',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
  };
}

describe('iMessage registration', () => {
  beforeEach(() => {
    vi.resetModules();
    registerChannelMock.mockReset();
    readEnvFileMock.mockReset();
  });

  it('registers channel factory and creates channel when credentials exist', async () => {
    readEnvFileMock.mockReturnValue({
      NANOCLAW_IMESSAGE_ENABLED: 'true',
      IMESSAGE_ACCOUNT: 'me@example.com',
      NANOCLAW_IMESSAGE_BACKEND: 'bluebubbles',
      BLUEBUBBLES_URL: 'http://localhost:1234',
      BLUEBUBBLES_PASSWORD: 'secret',
    });

    await import('./imessage.js');

    expect(registerChannelMock).toHaveBeenCalledTimes(1);
    const factory = registerChannelMock.mock.calls[0][1];
    const channel = factory(createOpts());
    expect(channel).not.toBeNull();
  });

  it('factory returns null when IMESSAGE_ACCOUNT missing', async () => {
    readEnvFileMock.mockReturnValue({
      NANOCLAW_IMESSAGE_ENABLED: 'true',
      NANOCLAW_IMESSAGE_BACKEND: 'bluebubbles',
      BLUEBUBBLES_URL: 'http://localhost:1234',
      BLUEBUBBLES_PASSWORD: 'secret',
    });

    await import('./imessage.js');

    const factory = registerChannelMock.mock.calls[0][1];
    expect(factory(createOpts())).toBeNull();
  });
});

describe('IMessageChannel behavior', () => {
  it('uses im: jid prefix in ownsJid()', async () => {
    const { IMessageChannel } = await import('./imessage.js');
    const channel = new IMessageChannel(
      createConfig(),
      createOpts(),
      new FakeAdapter(),
    );

    expect(channel.ownsJid('im:iMessage;+;chat123')).toBe(true);
    expect(channel.ownsJid('slack:C123')).toBe(false);
  });

  it('stage 0 stores metadata only and does not deliver onMessage', async () => {
    const { IMessageChannel } = await import('./imessage.js');
    const adapter = new FakeAdapter();
    const opts = createOpts();
    const channel = new IMessageChannel(
      createConfig({ rolloutStage: 0 }),
      opts,
      adapter,
    );

    await channel.connect();
    adapter.inboundHandler?.({
      platformMessageId: 'stage0-1',
      chatId: 'iMessage;+;chat123',
      sender: '+15550001111',
      timestamp: new Date().toISOString(),
      type: 'message',
      messageType: 'text',
      content: 'metadata-only',
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(opts.onChatMetadata).toHaveBeenCalledTimes(1);
    expect(opts.onMessage).toHaveBeenCalledTimes(0);
  });

  it('normalizes non-text message to placeholder', async () => {
    const { IMessageChannel } = await import('./imessage.js');
    const adapter = new FakeAdapter();
    const opts = createOpts();
    const channel = new IMessageChannel(createConfig(), opts, adapter);

    await channel.connect();
    adapter.inboundHandler?.({
      platformMessageId: 'msg-1',
      chatId: 'iMessage;+;chat123',
      sender: '+15550001111',
      timestamp: new Date().toISOString(),
      type: 'message',
      messageType: 'image',
      content: '',
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(opts.onMessage).toHaveBeenCalledTimes(1);
    const message = opts.onMessage.mock.calls[0][1];
    expect(message.content).toBe('[Image]');
  });

  it('deduplicates repeated inbound message IDs', async () => {
    const { IMessageChannel } = await import('./imessage.js');
    const adapter = new FakeAdapter();
    const opts = createOpts();
    const channel = new IMessageChannel(createConfig(), opts, adapter);
    await channel.connect();

    const event: IMessageInboundEvent = {
      platformMessageId: 'dup-1',
      chatId: 'iMessage;+;chat123',
      sender: '+15550001111',
      timestamp: new Date().toISOString(),
      type: 'message',
      messageType: 'text',
      content: 'hello',
    };

    adapter.inboundHandler?.(event);
    adapter.inboundHandler?.(event);
    await new Promise((r) => setTimeout(r, 0));

    expect(opts.onMessage).toHaveBeenCalledTimes(1);
  });

  it('handles out-of-order inbound timestamps without dropping unique IDs', async () => {
    const { IMessageChannel } = await import('./imessage.js');
    const adapter = new FakeAdapter();
    const opts = createOpts();
    const channel = new IMessageChannel(createConfig(), opts, adapter);
    await channel.connect();

    adapter.inboundHandler?.({
      platformMessageId: 'msg-newer',
      chatId: 'iMessage;+;chat123',
      sender: '+15550001111',
      timestamp: '2025-01-01T00:00:10.000Z',
      type: 'message',
      messageType: 'text',
      content: 'newer',
    });
    adapter.inboundHandler?.({
      platformMessageId: 'msg-older',
      chatId: 'iMessage;+;chat123',
      sender: '+15550001111',
      timestamp: '2025-01-01T00:00:05.000Z',
      type: 'message',
      messageType: 'text',
      content: 'older',
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(opts.onMessage).toHaveBeenCalledTimes(2);
  });

  it('queues sends while disconnected and flushes after connect', async () => {
    const { IMessageChannel } = await import('./imessage.js');
    const adapter = new FakeAdapter();
    const opts = createOpts();
    const channel = new IMessageChannel(createConfig(), opts, adapter);

    await channel.sendMessage('im:iMessage;+;chat123', 'queued before connect');
    expect(adapter.sent).toHaveLength(0);

    await channel.connect();

    await new Promise((r) => setTimeout(r, 10));
    expect(adapter.sent.length).toBeGreaterThanOrEqual(1);
    expect(adapter.sent[0].chatId).toBe('iMessage;+;chat123');
  });
});
