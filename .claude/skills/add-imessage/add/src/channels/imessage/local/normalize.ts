import { NewMessage } from '../../../types.js';
import {
  IMessageChatMetadata,
  IMessageChatTarget,
  jidForStableChatId,
} from '../backend.js';

export interface RawIMessageChatRecord {
  rowId: number;
  chatGuid?: string;
  chatIdentifier?: string;
  displayName?: string | null;
  lastMessageText?: string | null;
  lastMessageDate?: number | string | null;
  participants: string[];
}

export interface RawIMessageMessageRecord {
  rowId: number;
  guid?: string | null;
  text?: string | null;
  service?: string | null;
  isFromMe: boolean;
  date?: number | string | null;
  handleId?: string | null;
  chatGuid?: string;
  chatIdentifier?: string;
  displayName?: string | null;
  participants: string[];
}

export interface NormalizedMessageRecord {
  stableChatId: string;
  metadata: IMessageChatMetadata;
  message: NewMessage;
  checkpointRowId: number;
}

function cleanAddress(value?: string | null): string {
  return (value || '')
    .trim()
    .replace(/^mailto:/i, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

function stripServicePrefix(guid?: string): string {
  if (!guid) return '';
  return guid.replace(/^iMessage;/, '').replace(/^SMS;/, '');
}

export function stableChatIdFromParts(input: {
  chatGuid?: string;
  chatIdentifier?: string;
  participants?: string[];
}): string {
  const participants = (input.participants || [])
    .map(cleanAddress)
    .filter(Boolean);
  const normalizedGuid = stripServicePrefix(input.chatGuid);
  const normalizedIdentifier = cleanAddress(input.chatIdentifier);

  if (normalizedGuid.includes('chat')) {
    const chatId = normalizedGuid.split(';').pop() || normalizedGuid;
    return `chat:${chatId}`;
  }

  const directAddress =
    normalizedIdentifier || participants[0] || cleanAddress(normalizedGuid);
  if (directAddress) {
    return `dm:${directAddress}`;
  }

  return `chat:${normalizedGuid || 'unknown'}`;
}

export function targetFromChat(input: {
  stableChatId: string;
  chatGuid?: string;
  chatIdentifier?: string;
  participants?: string[];
}): IMessageChatTarget {
  if (input.stableChatId.startsWith('chat:')) {
    const guid = stripServicePrefix(input.chatGuid);
    return {
      kind: 'chat-guid',
      value: guid || input.stableChatId.slice('chat:'.length),
    };
  }

  const directAddress =
    cleanAddress(input.chatIdentifier) ||
    (input.participants || []).map(cleanAddress).find(Boolean) ||
    input.stableChatId.replace(/^dm:/, '');

  return { kind: 'handle', value: directAddress };
}

function toIsoTimestamp(rawDate?: number | string | null): string {
  if (rawDate === null || rawDate === undefined || rawDate === '') {
    return new Date().toISOString();
  }

  const numeric = typeof rawDate === 'string' ? Number(rawDate) : rawDate;
  if (!Number.isFinite(numeric)) {
    return new Date(String(rawDate)).toISOString();
  }

  // Apple Messages typically stores nanoseconds since 2001-01-01 00:00:00 UTC.
  const appleEpochMs = Date.UTC(2001, 0, 1);
  const asMilliseconds = numeric > 1e12 ? numeric / 1e6 : numeric / 1e3;
  return new Date(appleEpochMs + asMilliseconds).toISOString();
}

function deriveChatName(record: {
  displayName?: string | null;
  participants: string[];
  stableChatId: string;
}): string | undefined {
  if (record.displayName && record.displayName.trim()) {
    return record.displayName.trim();
  }

  if (record.participants.length > 1) {
    return record.participants.join(', ');
  }

  if (record.participants.length === 1) {
    return record.participants[0];
  }

  return record.stableChatId;
}

export function normalizeChatRecord(
  record: RawIMessageChatRecord,
): IMessageChatMetadata {
  const stableChatId = stableChatIdFromParts({
    chatGuid: record.chatGuid,
    chatIdentifier: record.chatIdentifier,
    participants: record.participants,
  });

  return {
    jid: jidForStableChatId(stableChatId),
    stableChatId,
    name: deriveChatName({
      displayName: record.displayName,
      participants: record.participants,
      stableChatId,
    }),
    timestamp: toIsoTimestamp(record.lastMessageDate),
    isGroup: record.participants.length > 1 || stableChatId.startsWith('chat:'),
    target: targetFromChat({
      stableChatId,
      chatGuid: record.chatGuid,
      chatIdentifier: record.chatIdentifier,
      participants: record.participants,
    }),
  };
}

export function normalizeMessageRecord(
  record: RawIMessageMessageRecord,
): NormalizedMessageRecord | null {
  const content = (record.text || '').trim();
  if (!content) {
    return null;
  }

  const stableChatId = stableChatIdFromParts({
    chatGuid: record.chatGuid,
    chatIdentifier: record.chatIdentifier,
    participants: record.participants,
  });
  const metadata = normalizeChatRecord({
    rowId: record.rowId,
    chatGuid: record.chatGuid,
    chatIdentifier: record.chatIdentifier,
    displayName: record.displayName,
    lastMessageDate: record.date,
    participants: record.participants,
  });
  const sender = record.isFromMe
    ? 'me'
    : cleanAddress(record.handleId) || metadata.target.value || 'unknown';

  const message: NewMessage = {
    id: record.guid || `imessage-${record.rowId}`,
    chat_jid: metadata.jid,
    sender,
    sender_name: record.isFromMe ? 'Me' : sender,
    content,
    timestamp: toIsoTimestamp(record.date),
    is_from_me: record.isFromMe,
    is_bot_message: false,
  };

  return {
    stableChatId,
    metadata,
    message,
    checkpointRowId: record.rowId,
  };
}
