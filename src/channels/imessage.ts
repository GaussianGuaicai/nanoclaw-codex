import fs from 'node:fs/promises';
import path from 'node:path';

import { ASSISTANT_NAME, LOGS_DIR } from '../config.js';
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

const DEAD_LETTER_FILE = path.join(LOGS_DIR, 'imessage-dead-letter.jsonl');
const INBOUND_DEDUPE_TTL_MS = 5 * 60_000;

interface IMessageChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

interface OutboundMessage {
  jid: string;
  chatId: string;
  text: string;
  queuedAt: string;
}

export class IMessageChannel implements Channel {
  name = 'imessage';

  private connected = false;
  private shuttingDown = false;
  private readonly opts: IMessageChannelOpts;
  private readonly config: IMessageBackendConfig;
  private activeBackend: IMessageBackend;
  private activeAdapter: IMessageAdapter;

  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private outboundQueue: OutboundMessage[] = [];
  private flushingQueue = false;
  private lastSendTimestamp = 0;

  private readonly inboundSeen = new Map<string, number>();

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
    this.shuttingDown = false;
    logger.info(
      { channel: this.name, state: 'connecting', backend: this.activeBackend },
      'iMessage channel connect lifecycle start',
    );

    const connected = await this.establishConnection();
    if (connected) return;

    this.scheduleReconnect('initial-connect-failed');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const chatId = jid.replace(/^im:/, '');

    if (this.outboundQueue.length >= this.config.send.queueMaxSize) {
      logger.error(
        {
          channel: this.name,
          queueSize: this.outboundQueue.length,
          queueMaxSize: this.config.send.queueMaxSize,
          jid,
        },
        'iMessage outbound queue is full; dropping message',
      );
      await this.writeDeadLetter(
        {
          jid,
          chatId,
          text,
          queuedAt: new Date().toISOString(),
        },
        new Error('outbound_queue_full'),
      );
      return;
    }

    this.outboundQueue.push({
      jid,
      chatId,
      text,
      queuedAt: new Date().toISOString(),
    });

    logger.debug(
      {
        channel: this.name,
        jid,
        queueSize: this.outboundQueue.length,
      },
      'Queued iMessage outbound message',
    );

    void this.flushOutboundQueue();
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('im:');
  }

  async disconnect(): Promise<void> {
    this.shuttingDown = true;
    this.connected = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    logger.info(
      {
        channel: this.name,
        state: 'disconnected',
        backend: this.activeBackend,
      },
      'iMessage channel disconnect lifecycle complete',
    );
  }

  private async establishConnection(): Promise<boolean> {
    const connected = await this.tryConnectWithFallback();
    if (!connected) {
      this.connected = false;
      logger.warn(
        {
          channel: this.name,
          state: 'connect_failed',
          backend: this.activeBackend,
        },
        'iMessage channel failed to connect',
      );
      return false;
    }

    await this.activeAdapter.subscribeInbound((event) => {
      void this.handleInboundEvent(event);
    });

    this.connected = true;
    this.reconnectAttempts = 0;
    logger.info(
      { channel: this.name, state: 'connected', backend: this.activeBackend },
      'iMessage channel connected',
    );

    void this.flushOutboundQueue();
    return true;
  }

  private scheduleReconnect(reason: string): void {
    if (this.shuttingDown) return;
    if (this.reconnectTimer) return;

    this.reconnectAttempts += 1;
    const delay = Math.min(
      this.config.reconnect.maxDelayMs,
      this.config.reconnect.initialDelayMs *
        2 ** Math.max(this.reconnectAttempts - 1, 0),
    );

    logger.warn(
      {
        channel: this.name,
        state: 'reconnecting',
        reason,
        attempt: this.reconnectAttempts,
        nextDelayMs: delay,
      },
      'Scheduling iMessage reconnect with exponential backoff',
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnectOnce();
    }, delay);
  }

  private async reconnectOnce(): Promise<void> {
    if (this.shuttingDown) return;

    logger.info(
      {
        channel: this.name,
        state: 'reconnect_attempt',
        attempt: this.reconnectAttempts,
      },
      'Attempting iMessage reconnect',
    );

    const ok = await this.establishConnection();
    if (!ok) this.scheduleReconnect('reconnect-attempt-failed');
  }

  private async flushOutboundQueue(): Promise<void> {
    if (this.flushingQueue) return;
    if (!this.connected) return;

    this.flushingQueue = true;
    const minIntervalMs = Math.max(
      1,
      Math.ceil(1000 / Math.max(this.config.send.rateLimitPerSecond, 1)),
    );

    try {
      while (this.outboundQueue.length > 0) {
        if (!this.connected) break;

        const msg = this.outboundQueue.shift()!;

        const waitMs = this.lastSendTimestamp + minIntervalMs - Date.now();
        if (waitMs > 0) await sleep(waitMs);

        try {
          await this.activeAdapter.send(msg.chatId, msg.text);
          this.lastSendTimestamp = Date.now();
          logger.info(
            {
              channel: this.name,
              jid: msg.jid,
              length: msg.text.length,
              backend: this.activeBackend,
              queueRemaining: this.outboundQueue.length,
            },
            'iMessage message sent',
          );
        } catch (err) {
          this.connected = false;
          await this.writeDeadLetter(msg, err);
          logger.error(
            {
              channel: this.name,
              jid: msg.jid,
              err,
              backend: this.activeBackend,
            },
            'Failed to send iMessage message; stored in dead-letter and scheduling reconnect',
          );
          this.scheduleReconnect('send-failed');
          break;
        }
      }
    } finally {
      this.flushingQueue = false;
    }
  }

  private async writeDeadLetter(
    msg: OutboundMessage,
    err: unknown,
  ): Promise<void> {
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      channel: this.name,
      backend: this.activeBackend,
      jid: msg.jid,
      chatId: msg.chatId,
      text: msg.text,
      queuedAt: msg.queuedAt,
      error: err instanceof Error ? err.message : String(err),
    });

    await fs.mkdir(path.dirname(DEAD_LETTER_FILE), { recursive: true });
    await fs.appendFile(DEAD_LETTER_FILE, `${line}\n`, 'utf8');
  }

  private async handleInboundEvent(event: IMessageInboundEvent): Promise<void> {
    const jid = `im:${event.chatId}`;
    const dedupeId = `${event.platformMessageId}:${event.chatId}`;

    this.pruneInboundDedupeCache();
    if (this.inboundSeen.has(dedupeId)) {
      logger.debug(
        {
          channel: this.name,
          dedupeId,
          backend: this.activeBackend,
        },
        'Skipping duplicated iMessage inbound event (memory cache)',
      );
      return;
    }
    this.inboundSeen.set(dedupeId, Date.now());

    const timestamp = event.timestamp;
    const chatMeta = await this.activeAdapter.resolveChatMeta(event.chatId);
    const isGroup = chatMeta?.isGroup ?? true;

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

  private pruneInboundDedupeCache(): void {
    const cutoff = Date.now() - INBOUND_DEDUPE_TTL_MS;
    for (const [key, value] of this.inboundSeen.entries()) {
      if (value < cutoff) this.inboundSeen.delete(key);
    }
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
