import { logger } from '../../../logger.js';
import {
  IMessageAdapter,
  IMessageChatMeta,
  IMessageInboundEvent,
} from './types.js';

interface BlueBubblesAdapterConfig {
  url: string;
  password: string;
}

interface BlueBubblesSendResponse {
  success?: boolean;
}

interface BlueBubblesChatResponse {
  chat?: {
    displayName?: string;
    isGroup?: boolean;
  };
}

type BlueBubblesInboundSource = 'webhook' | 'websocket';

export function parseBlueBubblesInboundPayload(
  payload: unknown,
  source: BlueBubblesInboundSource,
): IMessageInboundEvent | null {
  if (!payload || typeof payload !== 'object') return null;

  const record = payload as Record<string, unknown>;
  const message =
    source === 'websocket' &&
    record.data &&
    typeof record.data === 'object' &&
    !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : record;

  const platformMessageId = readString(
    message.guid,
    message.messageGuid,
    message.id,
  );
  const chatId = readString(message.chatGuid, message.conversationId);
  const timestampValue = readNumber(
    message.dateCreated,
    message.date,
    Date.now(),
  );

  if (!platformMessageId || !chatId) return null;

  const sender = readString(
    message.handle,
    message.address,
    message.sender,
    'unknown',
  );
  const senderName = readString(message.displayName, message.senderName);
  const content = readString(message.text, message.message, '');
  const attachmentName = readString(message.fileName, message.attachmentName);
  const isFromMe = readBool(message.isFromMe, message.fromMe);
  const messageType = parseMessageType(readString(message.type, 'text'));

  return {
    platformMessageId,
    chatId,
    sender,
    senderName,
    timestamp: new Date(timestampValue).toISOString(),
    type: 'message',
    messageType,
    content,
    attachmentName,
    isFromMe,
  };
}

export class BlueBubblesAdapter implements IMessageAdapter {
  private readonly url: string;
  private readonly password: string;

  constructor(config: BlueBubblesAdapterConfig) {
    this.url = config.url.replace(/\/$/, '');
    this.password = config.password;
  }

  async connect(): Promise<void> {
    logger.info({ backend: 'bluebubbles' }, 'iMessage adapter connected');
  }

  async subscribeInbound(
    _handler: (event: IMessageInboundEvent) => void,
  ): Promise<void> {
    logger.info(
      { backend: 'bluebubbles' },
      'BlueBubbles inbound subscription not configured',
    );
  }

  async send(chatId: string, text: string): Promise<void> {
    const payload = {
      chatGuid: chatId,
      message: text,
      method: 'apple-script',
    };

    const response = await this.request<BlueBubblesSendResponse>(
      '/api/v1/message/text',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    );

    if (response && response.success === false) {
      throw new Error('BlueBubbles send returned success=false');
    }
  }

  async resolveChatMeta(chatId: string): Promise<IMessageChatMeta | null> {
    try {
      const response = await this.request<BlueBubblesChatResponse>(
        `/api/v1/chat/${encodeURIComponent(chatId)}`,
      );
      if (!response?.chat) return null;

      return {
        name: response.chat.displayName,
        isGroup: response.chat.isGroup,
      };
    } catch (err) {
      logger.debug(
        { chatId, err },
        'Failed to resolve BlueBubbles chat metadata',
      );
      return null;
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.request('/api/v1/ping');
      return true;
    } catch (err) {
      logger.warn(
        { err, backend: 'bluebubbles' },
        'BlueBubbles health check failed',
      );
      return false;
    }
  }

  private async request<T = unknown>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const response = await fetch(`${this.url}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        password: this.password,
        ...(init.headers || {}),
      },
    });

    if (!response.ok) {
      throw new Error(`BlueBubbles request failed: ${response.status}`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }
}

function readString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

function readNumber(...values: unknown[]): number {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return Date.now();
}

function readBool(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === 'boolean') return value;
  }
  return undefined;
}

function parseMessageType(
  value: string,
): IMessageInboundEvent['messageType'] | undefined {
  const normalized = value.toLowerCase();
  if (
    normalized === 'text' ||
    normalized === 'image' ||
    normalized === 'video' ||
    normalized === 'voice' ||
    normalized === 'audio' ||
    normalized === 'attachment' ||
    normalized === 'sticker' ||
    normalized === 'location' ||
    normalized === 'contact' ||
    normalized === 'system'
  ) {
    return normalized;
  }
  return undefined;
}
