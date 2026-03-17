import { ASSISTANT_NAME } from '../config.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
  NewMessage,
} from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';
import { BlueBubblesAdapter } from './imessage/adapters/bluebubbles-adapter.js';
import { SmserverAdapter } from './imessage/adapters/smserver-adapter.js';
import {
  IMessageAdapter,
  IMessageInboundEvent,
} from './imessage/adapters/types.js';
import {
  IMessageBackend,
  IMessageBackendConfig,
  loadIMessageConfig,
} from './imessage/imessage-config.js';

interface IMessageChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class IMessageChannel implements Channel {
  name = 'imessage';

  private connected = false;
  private readonly opts: IMessageChannelOpts;
  private readonly config: IMessageBackendConfig;
  private activeBackend: IMessageBackend;
  private activeAdapter: IMessageAdapter;

  constructor(
    config: IMessageBackendConfig,
    opts: IMessageChannelOpts,
    adapter: IMessageAdapter,
  ) {
    this.config = config;
    this.opts = opts;
    this.activeBackend = config.backend;
    this.activeAdapter = adapter;
  }

  async connect(): Promise<void> {
    const connected = await this.tryConnectWithFallback();
    if (!connected) {
      this.connected = false;
      return;
    }

    await this.activeAdapter.subscribeInbound((event) => {
      void this.handleInboundEvent(event);
    });

    this.connected = true;
    logger.info(
      { channel: this.name, backend: this.activeBackend },
      'iMessage channel connected',
    );
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.connected) {
      logger.warn({ jid }, 'iMessage channel not connected, skipping send');
      return;
    }

    const chatId = jid.replace(/^im:/, '');

    try {
      await this.activeAdapter.send(chatId, text);
      logger.info(
        { jid, length: text.length, backend: this.activeBackend },
        'iMessage message sent',
      );
    } catch (err) {
      logger.error(
        { jid, err, backend: this.activeBackend },
        'Failed to send iMessage message',
      );
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('im:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    logger.info('iMessage channel disconnected');
  }

  private async handleInboundEvent(event: IMessageInboundEvent): Promise<void> {
    const jid = `im:${event.chatId}`;
    const timestamp = event.timestamp;
    const chatMeta = await this.activeAdapter.resolveChatMeta(event.chatId);
    const isGroup = chatMeta?.isGroup ?? true;

    // Always store metadata for chat discovery and routing.
    this.opts.onChatMetadata(
      jid,
      timestamp,
      chatMeta?.name,
      'imessage',
      isGroup,
    );

    const eventType = event.type || 'message';
    if (
      eventType === 'receipt' ||
      eventType === 'edit' ||
      eventType === 'retract'
    ) {
      logger.debug(
        {
          channel: this.name,
          eventType,
          backend: this.activeBackend,
          chatId: event.chatId,
          platformMessageId: event.platformMessageId,
        },
        'Received iMessage non-message event',
      );
      return;
    }

    const groups = this.opts.registeredGroups();
    if (!groups[jid]) return;

    const normalized = this.normalizeInboundEvent(event, jid);
    if (!normalized.content) {
      logger.debug(
        {
          channel: this.name,
          backend: this.activeBackend,
          chatId: event.chatId,
          platformMessageId: event.platformMessageId,
        },
        'Skipping iMessage inbound event with empty normalized content',
      );
      return;
    }

    this.opts.onMessage(jid, normalized);
  }

  private normalizeInboundEvent(
    event: IMessageInboundEvent,
    jid: string,
  ): NewMessage {
    const senderName = event.senderName || event.sender || 'unknown';
    const isFromMe =
      event.isFromMe !== undefined
        ? event.isFromMe
        : event.sender === this.config.account;

    const messageType = event.messageType || 'text';
    const content = normalizeContent(
      event.content || '',
      messageType,
      event.attachmentName,
    );

    // Dedupe key: platform_message_id + chat_id
    const dedupeId = `${event.platformMessageId}:${event.chatId}`;

    return {
      id: dedupeId,
      chat_jid: jid,
      sender: event.sender,
      sender_name: senderName,
      content,
      timestamp: event.timestamp,
      is_from_me: isFromMe,
      is_bot_message: isFromMe || senderName === ASSISTANT_NAME,
    };
  }

  private async tryConnectWithFallback(): Promise<boolean> {
    const primaryHealthy = await this.connectAndHealthCheck(
      this.activeBackend,
      this.activeAdapter,
    );
    if (primaryHealthy) return true;

    if (!this.config.fallbackBackend) {
      logger.error(
        { channel: this.name, primaryBackend: this.activeBackend },
        'iMessage primary backend unavailable and no fallback configured',
      );
      return false;
    }

    const fallbackAdapter = createAdapter(
      this.config,
      this.config.fallbackBackend,
    );
    if (!fallbackAdapter) {
      logger.error(
        {
          channel: this.name,
          primaryBackend: this.activeBackend,
          fallbackBackend: this.config.fallbackBackend,
        },
        'iMessage fallback backend missing required configuration',
      );
      return false;
    }

    logger.warn(
      {
        channel: this.name,
        primaryBackend: this.activeBackend,
        fallbackBackend: this.config.fallbackBackend,
      },
      'iMessage primary backend unhealthy, falling back to secondary backend',
    );

    const fallbackHealthy = await this.connectAndHealthCheck(
      this.config.fallbackBackend,
      fallbackAdapter,
    );
    if (!fallbackHealthy) {
      logger.error(
        {
          channel: this.name,
          primaryBackend: this.activeBackend,
          fallbackBackend: this.config.fallbackBackend,
        },
        'Both iMessage primary and fallback backends are unavailable',
      );
      return false;
    }

    this.activeBackend = this.config.fallbackBackend;
    this.activeAdapter = fallbackAdapter;
    return true;
  }

  private async connectAndHealthCheck(
    backend: IMessageBackend,
    adapter: IMessageAdapter,
  ): Promise<boolean> {
    try {
      await adapter.connect();
      const healthy = await adapter.healthCheck();
      if (!healthy) {
        logger.warn(
          { channel: this.name, backend },
          'iMessage backend health check failed',
        );
      }
      return healthy;
    } catch (err) {
      logger.warn(
        { channel: this.name, backend, err },
        'iMessage backend connect/healthcheck threw',
      );
      return false;
    }
  }
}

function normalizeContent(
  rawContent: string,
  messageType:
    | 'text'
    | 'image'
    | 'video'
    | 'voice'
    | 'audio'
    | 'attachment'
    | 'sticker'
    | 'location'
    | 'contact'
    | 'system',
  attachmentName?: string,
): string {
  if (messageType === 'text' || messageType === 'system') {
    return rawContent.trim();
  }

  if (messageType === 'image') return '[Image]';
  if (messageType === 'video') return '[Video]';
  if (messageType === 'voice') return '[Voice]';
  if (messageType === 'audio') return '[Audio]';
  if (messageType === 'sticker') return '[Sticker]';
  if (messageType === 'location') return '[Location]';
  if (messageType === 'contact') return '[Contact]';
  if (messageType === 'attachment') {
    const name = attachmentName?.trim() || 'file';
    return `[Attachment: ${name}]`;
  }

  return rawContent.trim();
}

function validateRiskyMode(config: IMessageBackendConfig): boolean {
  if (!config.riskyMode.enableDirectChatDb) return true;

  if (!config.riskyMode.confirmed) {
    logger.error(
      {
        channel: 'imessage',
        mode: 'direct-chatdb',
        requiredEnv: 'NANOCLAW_IMESSAGE_I_UNDERSTAND_CHATDB_RISKS=true',
      },
      'Refusing to start high-risk iMessage mode without explicit confirmation',
    );
    return false;
  }

  logger.warn(
    { channel: 'imessage', mode: 'direct-chatdb' },
    'High-risk iMessage mode enabled: direct chat.db access may expose Apple ID and local message data',
  );
  return true;
}

function createAdapter(
  config: IMessageBackendConfig,
  backend: IMessageBackend,
): IMessageAdapter | null {
  if (backend === 'bluebubbles') {
    if (!config.blueBubbles.url || !config.blueBubbles.password) return null;
    return new BlueBubblesAdapter({
      url: config.blueBubbles.url,
      password: config.blueBubbles.password,
    });
  }

  if (backend === 'smserver') {
    if (!config.smserver.url) return null;
    return new SmserverAdapter({ url: config.smserver.url });
  }

  return null;
}

registerChannel('imessage', (opts: ChannelOpts) => {
  const config = loadIMessageConfig();

  if (!config.account) {
    logger.warn('iMessage: IMESSAGE_ACCOUNT not set');
    return null;
  }

  if (!validateRiskyMode(config)) {
    return null;
  }

  const adapter = createAdapter(config, config.backend);
  if (!adapter) {
    logger.warn(
      { backend: config.backend },
      'iMessage: selected backend missing required credentials/config',
    );
    return null;
  }

  return new IMessageChannel(config, opts, adapter);
});
