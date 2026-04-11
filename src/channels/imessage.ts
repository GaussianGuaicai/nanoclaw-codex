import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import { promisify } from 'util';

import Database from 'better-sqlite3';

import { getRouterState, setRouterState } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import {
  Channel,
  NewMessage,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';
import { registerChannel } from './registry.js';

export type IMessageBackendName = 'local-macos' | 'bluebubbles';

export interface IMessageConfig {
  enabled: boolean;
  backend: IMessageBackendName;
  pollIntervalMs: number;
  dbPath: string;
}

export interface IMessageChatTarget {
  kind: 'handle' | 'chat-guid';
  value: string;
}

export interface IMessageChatMetadata {
  jid: string;
  stableChatId: string;
  name?: string;
  timestamp: string;
  isGroup: boolean;
  target: IMessageChatTarget;
}

export interface IMessageInboundEvent {
  jid: string;
  stableChatId: string;
  message: NewMessage;
  metadata: IMessageChatMetadata;
}

export interface IMessageBackendCallbacks {
  onMessage(event: IMessageInboundEvent): void;
  onChatMetadata(metadata: IMessageChatMetadata): void;
  isRegisteredJid(jid: string): boolean;
}

export interface IMessageBackend {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  sendText(stableChatId: string, text: string): Promise<void>;
  syncChats(force: boolean): Promise<void>;
}

const execFileAsync = promisify(execFile);
const CHECKPOINT_KEY = 'imessage.local-macos.checkpoint';

interface SqliteColumn {
  name: string;
}

interface RawIMessageChatRecord {
  rowId: number;
  chatGuid?: string;
  chatIdentifier?: string;
  displayName?: string | null;
  lastMessageDate?: number | string | null;
  participants: string[];
}

interface RawIMessageMessageRecord {
  rowId: number;
  guid?: string | null;
  text?: string | null;
  isFromMe: boolean;
  date?: number | string | null;
  handleId?: string | null;
  chatGuid?: string;
  chatIdentifier?: string;
  displayName?: string | null;
  participants: string[];
}

interface NormalizedMessageRecord {
  stableChatId: string;
  metadata: IMessageChatMetadata;
  message: NewMessage;
  checkpointRowId: number;
}

interface IMessageCheckpoint {
  lastRowId: number;
  updatedAt: string;
}

interface IMessageChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  config?: IMessageConfig;
  backend?: IMessageBackend;
}

function expandHome(filePath: string): string {
  if (filePath.startsWith('~/')) {
    return `${os.homedir()}${filePath.slice(1)}`;
  }
  return filePath;
}

export function getIMessageConfig(): IMessageConfig {
  const env = readEnvFile([
    'IMESSAGE_ENABLED',
    'IMESSAGE_BACKEND',
    'IMESSAGE_POLL_INTERVAL_MS',
    'IMESSAGE_DB_PATH',
  ]);

  const enabledRaw = process.env.IMESSAGE_ENABLED ?? env.IMESSAGE_ENABLED;
  const backendRaw = process.env.IMESSAGE_BACKEND ?? env.IMESSAGE_BACKEND;
  const pollRaw =
    process.env.IMESSAGE_POLL_INTERVAL_MS ?? env.IMESSAGE_POLL_INTERVAL_MS;
  const dbPathRaw = process.env.IMESSAGE_DB_PATH ?? env.IMESSAGE_DB_PATH;

  const backend: IMessageBackendName =
    backendRaw === 'bluebubbles' ? 'bluebubbles' : 'local-macos';

  return {
    enabled: enabledRaw === 'true',
    backend,
    pollIntervalMs: Math.max(250, parseInt(pollRaw || '1500', 10) || 1500),
    dbPath: expandHome(dbPathRaw || '~/Library/Messages/chat.db'),
  };
}

export function jidForStableChatId(stableChatId: string): string {
  return `imessage:${stableChatId}`;
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

function normalizeChatRecord(record: RawIMessageChatRecord): IMessageChatMetadata {
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

function normalizeMessageRecord(
  record: RawIMessageMessageRecord,
): NormalizedMessageRecord | null {
  const content = (record.text || '').trim();
  if (!content) return null;

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

  return {
    stableChatId: metadata.stableChatId,
    metadata,
    message: {
      id: record.guid || `imessage-${record.rowId}`,
      chat_jid: metadata.jid,
      sender,
      sender_name: record.isFromMe ? 'Me' : sender,
      content,
      timestamp: toIsoTimestamp(record.date),
      is_from_me: record.isFromMe,
      is_bot_message: false,
    },
    checkpointRowId: record.rowId,
  };
}

function loadIMessageCheckpoint(): IMessageCheckpoint {
  const raw = getRouterState(CHECKPOINT_KEY);
  if (!raw) {
    return { lastRowId: 0, updatedAt: new Date(0).toISOString() };
  }

  try {
    const parsed = JSON.parse(raw) as Partial<IMessageCheckpoint>;
    return {
      lastRowId: Math.max(0, parsed.lastRowId || 0),
      updatedAt: parsed.updatedAt || new Date(0).toISOString(),
    };
  } catch {
    return { lastRowId: 0, updatedAt: new Date(0).toISOString() };
  }
}

function saveIMessageCheckpoint(lastRowId: number): IMessageCheckpoint {
  const checkpoint: IMessageCheckpoint = {
    lastRowId: Math.max(0, lastRowId),
    updatedAt: new Date().toISOString(),
  };
  setRouterState(CHECKPOINT_KEY, JSON.stringify(checkpoint));
  return checkpoint;
}

function escapeAppleScriptString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

function scriptForTarget(target: IMessageChatTarget, text: string): string {
  const escapedText = escapeAppleScriptString(text);
  if (target.kind === 'chat-guid') {
    const escapedChatId = escapeAppleScriptString(target.value);
    return `
      tell application "Messages"
        set targetChat to chat id "${escapedChatId}"
        send "${escapedText}" to targetChat
      end tell
    `;
  }

  const escapedHandle = escapeAppleScriptString(target.value);
  return `
    tell application "Messages"
      set targetService to 1st service whose service type = iMessage
      set targetBuddy to buddy "${escapedHandle}" of targetService
      send "${escapedText}" to targetBuddy
    end tell
  `;
}

async function sendTextViaAppleScript(
  target: IMessageChatTarget,
  text: string,
): Promise<void> {
  await execFileAsync('osascript', ['-e', scriptForTarget(target, text)]);
}

function openReadOnlyDatabase(dbPath: string): Database.Database {
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

function getColumnSet(db: Database.Database, table: string): Set<string> {
  const rows = db
    .prepare(`PRAGMA table_info(${table})`)
    .all() as SqliteColumn[];
  return new Set(rows.map((row) => row.name));
}

function pickFirst(
  columns: Set<string>,
  candidates: string[],
  fallback: string,
): string {
  return candidates.find((candidate) => columns.has(candidate)) || fallback;
}

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
    )
    .get(tableName) as { name?: string } | undefined;
  return !!row?.name;
}

function decodeParticipants(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split('\u001f')
    .map((item) => item.trim())
    .filter(Boolean);
}

function readLatestMessageRowId(dbPath: string): number {
  const db = openReadOnlyDatabase(dbPath);
  try {
    const row = db
      .prepare('SELECT MAX(ROWID) AS maxRowId FROM message')
      .get() as { maxRowId?: number | null } | undefined;
    return Math.max(0, row?.maxRowId || 0);
  } catch {
    return 0;
  } finally {
    db.close();
  }
}

function readRecentChats(dbPath: string, limit = 50): IMessageChatMetadata[] {
  const db = openReadOnlyDatabase(dbPath);
  try {
    const chatColumns = getColumnSet(db, 'chat');
    const messageColumns = getColumnSet(db, 'message');
    const chatIdentifierColumn = pickFirst(
      chatColumns,
      ['chat_identifier', 'guid'],
      'guid',
    );
    const displayNameColumn = pickFirst(chatColumns, ['display_name'], 'display_name');
    const dateColumn = pickFirst(messageColumns, ['date', 'date_delivered'], 'date');
    const textColumn = pickFirst(messageColumns, ['text'], 'text');

    const rows = db
      .prepare(
        `
          SELECT
            chat.ROWID AS rowId,
            chat.guid AS chatGuid,
            chat.${chatIdentifierColumn} AS chatIdentifier,
            chat.${displayNameColumn} AS displayName,
            MAX(message.${dateColumn}) AS lastMessageDate,
            MAX(message.${textColumn}) AS lastMessageText,
            REPLACE(GROUP_CONCAT(DISTINCT handle.id), ',', char(31)) AS participants
          FROM chat
          LEFT JOIN chat_handle_join ON chat_handle_join.chat_id = chat.ROWID
          LEFT JOIN handle ON handle.ROWID = chat_handle_join.handle_id
          LEFT JOIN chat_message_join ON chat_message_join.chat_id = chat.ROWID
          LEFT JOIN message ON message.ROWID = chat_message_join.message_id
          GROUP BY chat.ROWID
          ORDER BY MAX(message.${dateColumn}) DESC
          LIMIT ?
        `,
      )
      .all(limit) as Array<{
      rowId: number;
      chatGuid?: string;
      chatIdentifier?: string;
      displayName?: string | null;
      lastMessageDate?: number | string | null;
      participants?: string;
    }>;

    return rows.map((row) =>
      normalizeChatRecord({
        rowId: row.rowId,
        chatGuid: row.chatGuid,
        chatIdentifier: row.chatIdentifier,
        displayName: row.displayName,
        lastMessageDate: row.lastMessageDate,
        participants: decodeParticipants(row.participants),
      }),
    );
  } finally {
    db.close();
  }
}

function readMessagesSince(
  dbPath: string,
  afterRowId: number,
  limit = 200,
): { messages: NormalizedMessageRecord[]; maxRowId: number } {
  const db = openReadOnlyDatabase(dbPath);
  try {
    if (!tableExists(db, 'chat_message_join')) {
      return { messages: [], maxRowId: afterRowId };
    }

    const messageColumns = getColumnSet(db, 'message');
    const chatColumns = getColumnSet(db, 'chat');
    const textColumn = pickFirst(messageColumns, ['text'], 'text');
    const fromMeColumn = pickFirst(messageColumns, ['is_from_me'], 'is_from_me');
    const dateColumn = pickFirst(messageColumns, ['date', 'date_delivered'], 'date');
    const handleColumn = pickFirst(messageColumns, ['handle_id'], 'handle_id');
    const chatIdentifierColumn = pickFirst(
      chatColumns,
      ['chat_identifier', 'guid'],
      'guid',
    );
    const displayNameColumn = pickFirst(chatColumns, ['display_name'], 'display_name');

    const rows = db
      .prepare(
        `
          SELECT
            message.ROWID AS rowId,
            message.guid AS guid,
            message.${textColumn} AS text,
            message.${fromMeColumn} AS isFromMe,
            message.${dateColumn} AS date,
            handle.id AS handleId,
            chat.guid AS chatGuid,
            chat.${chatIdentifierColumn} AS chatIdentifier,
            chat.${displayNameColumn} AS displayName,
            REPLACE(GROUP_CONCAT(DISTINCT participant.id), ',', char(31)) AS participants
          FROM message
          INNER JOIN chat_message_join ON chat_message_join.message_id = message.ROWID
          INNER JOIN chat ON chat.ROWID = chat_message_join.chat_id
          LEFT JOIN handle ON handle.ROWID = message.${handleColumn}
          LEFT JOIN chat_handle_join ON chat_handle_join.chat_id = chat.ROWID
          LEFT JOIN handle AS participant ON participant.ROWID = chat_handle_join.handle_id
          WHERE message.ROWID > ?
          GROUP BY message.ROWID
          ORDER BY message.ROWID ASC
          LIMIT ?
        `,
      )
      .all(afterRowId, limit) as Array<{
      rowId: number;
      guid?: string | null;
      text?: string | null;
      isFromMe: number;
      date?: number | string | null;
      handleId?: string | null;
      chatGuid?: string;
      chatIdentifier?: string;
      displayName?: string | null;
      participants?: string;
    }>;

    const messages = rows
      .map((row) =>
        normalizeMessageRecord({
          rowId: row.rowId,
          guid: row.guid,
          text: row.text,
          isFromMe: !!row.isFromMe,
          date: row.date,
          handleId: row.handleId,
          chatGuid: row.chatGuid,
          chatIdentifier: row.chatIdentifier,
          displayName: row.displayName,
          participants: decodeParticipants(row.participants),
        }),
      )
      .filter((value): value is NormalizedMessageRecord => !!value);

    return {
      messages,
      maxRowId: rows.reduce((acc, row) => Math.max(acc, row.rowId), afterRowId),
    };
  } finally {
    db.close();
  }
}

class BlueBubblesBackend implements IMessageBackend {
  async connect(): Promise<void> {
    logger.warn(
      'IMESSAGE_BACKEND=bluebubbles is not implemented yet; skipping iMessage channel startup',
    );
  }

  async disconnect(): Promise<void> {}

  isConnected(): boolean {
    return false;
  }

  async sendText(_stableChatId: string, _text: string): Promise<void> {
    logger.warn('Ignoring outbound iMessage send because bluebubbles is not implemented');
  }

  async syncChats(_force: boolean): Promise<void> {}
}

class LocalMacOSIMessageBackend implements IMessageBackend {
  private connected = false;
  private pollTimer: NodeJS.Timeout | undefined;
  private checkpoint = loadIMessageCheckpoint();
  private lastSyncAt = 0;
  private chatTargets = new Map<string, IMessageChatTarget>();

  constructor(
    private readonly config: IMessageConfig,
    private readonly callbacks: IMessageBackendCallbacks,
  ) {}

  async connect(): Promise<void> {
    if (process.platform !== 'darwin') {
      throw new Error('local-macos iMessage backend requires macOS');
    }
    if (!fs.existsSync(this.config.dbPath)) {
      throw new Error(`iMessage chat.db not found at ${this.config.dbPath}`);
    }

    if (this.checkpoint.lastRowId === 0) {
      const latestRowId = readLatestMessageRowId(this.config.dbPath);
      if (latestRowId > 0) {
        this.checkpoint = saveIMessageCheckpoint(latestRowId);
      }
    }

    this.connected = true;
    await this.syncChats(true);
    this.startPolling();
    await this.pollOnce();
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  async sendText(stableChatId: string, text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;

    const target =
      this.chatTargets.get(stableChatId) ||
      this.targetFromStableChatId(stableChatId);
    await sendTextViaAppleScript(target, trimmed);
  }

  async syncChats(force: boolean): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastSyncAt < 30_000) return;

    try {
      for (const metadata of readRecentChats(this.config.dbPath, 50)) {
        this.chatTargets.set(metadata.stableChatId, metadata.target);
        this.callbacks.onChatMetadata(metadata);
      }
      this.lastSyncAt = now;
    } catch (error) {
      logger.error({ error }, 'Failed to sync iMessage chats from local macOS backend');
    }
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      void this.pollOnce();
    }, this.config.pollIntervalMs);
  }

  private async pollOnce(): Promise<void> {
    if (!this.connected) return;
    try {
      const result = readMessagesSince(
        this.config.dbPath,
        this.checkpoint.lastRowId,
        200,
      );

      for (const entry of result.messages) {
        this.chatTargets.set(entry.stableChatId, entry.metadata.target);
        this.callbacks.onChatMetadata(entry.metadata);
        if (
          !entry.message.is_from_me &&
          this.callbacks.isRegisteredJid(entry.metadata.jid)
        ) {
          this.callbacks.onMessage({
            jid: entry.metadata.jid,
            stableChatId: entry.stableChatId,
            message: entry.message,
            metadata: entry.metadata,
          });
        }
      }

      if (result.maxRowId > this.checkpoint.lastRowId) {
        this.checkpoint = saveIMessageCheckpoint(result.maxRowId);
      }
    } catch (error) {
      logger.error({ error }, 'Failed to poll local macOS iMessage backend');
    }
  }

  private targetFromStableChatId(stableChatId: string): IMessageChatTarget {
    if (stableChatId.startsWith('chat:')) {
      return {
        kind: 'chat-guid',
        value: stableChatId.slice('chat:'.length),
      };
    }
    return {
      kind: 'handle',
      value: stableChatId.replace(/^dm:/, ''),
    };
  }
}

export class IMessageChannel implements Channel {
  name = 'imessage';
  private readonly config: IMessageConfig;
  private readonly backend: IMessageBackend;

  constructor(private readonly opts: IMessageChannelOpts) {
    this.config = opts.config || getIMessageConfig();
    this.backend = opts.backend || this.createBackend(this.config);
  }

  async connect(): Promise<void> {
    try {
      await this.backend.connect();
    } catch (error) {
      logger.error(
        { error, backend: this.config.backend },
        'Failed to connect iMessage channel',
      );
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const stableChatId = jid.replace(/^imessage:/, '');
    try {
      await this.backend.sendText(stableChatId, text);
    } catch (error) {
      logger.warn({ error, jid }, 'Failed to send iMessage text');
    }
  }

  isConnected(): boolean {
    return this.backend.isConnected();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('imessage:');
  }

  async disconnect(): Promise<void> {
    await this.backend.disconnect();
  }

  async syncGroups(force: boolean): Promise<void> {
    await this.backend.syncChats(force);
  }

  private createBackend(config: IMessageConfig): IMessageBackend {
    const callbacks: IMessageBackendCallbacks = {
      onMessage: ({ jid, message }) => this.opts.onMessage(jid, message),
      onChatMetadata: (metadata) =>
        this.opts.onChatMetadata(
          metadata.jid,
          metadata.timestamp,
          metadata.name,
          'imessage',
          metadata.isGroup,
        ),
      isRegisteredJid: (jid) => !!this.opts.registeredGroups()[jid],
    };

    if (config.backend === 'bluebubbles') {
      return new BlueBubblesBackend();
    }

    return new LocalMacOSIMessageBackend(config, callbacks);
  }
}

registerChannel('imessage', (opts) => {
  const config = getIMessageConfig();

  if (!config.enabled) {
    logger.info('iMessage channel disabled via IMESSAGE_ENABLED');
    return null;
  }

  if (config.backend === 'bluebubbles') {
    logger.warn(
      'IMESSAGE_BACKEND=bluebubbles is not implemented yet; skipping iMessage channel startup',
    );
    return null;
  }

  if (process.platform !== 'darwin') {
    logger.info(
      { platform: process.platform },
      'Skipping iMessage local-macos backend on non-macOS host',
    );
    return null;
  }

  if (!fs.existsSync(config.dbPath)) {
    logger.warn(
      { dbPath: config.dbPath },
      'Skipping iMessage channel: IMESSAGE_DB_PATH not found',
    );
    return null;
  }

  return new IMessageChannel({ ...opts, config });
});
