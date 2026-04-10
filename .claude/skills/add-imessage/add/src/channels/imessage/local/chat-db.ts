import Database from 'better-sqlite3';

import {
  normalizeChatRecord,
  normalizeMessageRecord,
  RawIMessageChatRecord,
  RawIMessageMessageRecord,
} from './normalize.js';

interface SqliteColumn {
  name: string;
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

export interface ChatQueryResult {
  chats: ReturnType<typeof normalizeChatRecord>[];
}

export interface MessageQueryResult {
  messages: NonNullable<ReturnType<typeof normalizeMessageRecord>>[];
  maxRowId: number;
}

export function readLatestMessageRowId(dbPath: string): number {
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

export function readRecentChats(dbPath: string, limit = 50): ChatQueryResult {
  const db = openReadOnlyDatabase(dbPath);
  try {
    const chatColumns = getColumnSet(db, 'chat');
    const messageColumns = getColumnSet(db, 'message');
    const chatIdentifierColumn = pickFirst(
      chatColumns,
      ['chat_identifier', 'guid'],
      'guid',
    );
    const displayNameColumn = pickFirst(
      chatColumns,
      ['display_name', 'display_name'],
      'display_name',
    );
    const dateColumn = pickFirst(
      messageColumns,
      ['date', 'date_delivered'],
      'date',
    );
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
            GROUP_CONCAT(DISTINCT handle.id, char(31)) AS participants
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
      lastMessageText?: string | null;
      participants?: string;
    }>;

    return {
      chats: rows.map((row) =>
        normalizeChatRecord({
          rowId: row.rowId,
          chatGuid: row.chatGuid,
          chatIdentifier: row.chatIdentifier,
          displayName: row.displayName,
          lastMessageDate: row.lastMessageDate,
          lastMessageText: row.lastMessageText,
          participants: decodeParticipants(row.participants),
        }),
      ),
    };
  } finally {
    db.close();
  }
}

export function readMessagesSince(
  dbPath: string,
  afterRowId: number,
  limit = 200,
): MessageQueryResult {
  const db = openReadOnlyDatabase(dbPath);
  try {
    if (!tableExists(db, 'chat_message_join')) {
      return { messages: [], maxRowId: afterRowId };
    }

    const messageColumns = getColumnSet(db, 'message');
    const chatColumns = getColumnSet(db, 'chat');
    const textColumn = pickFirst(messageColumns, ['text'], 'text');
    const serviceColumn = pickFirst(
      messageColumns,
      ['service', 'service_name'],
      'service',
    );
    const fromMeColumn = pickFirst(
      messageColumns,
      ['is_from_me'],
      'is_from_me',
    );
    const dateColumn = pickFirst(
      messageColumns,
      ['date', 'date_delivered'],
      'date',
    );
    const handleColumn = pickFirst(messageColumns, ['handle_id'], 'handle_id');
    const chatIdentifierColumn = pickFirst(
      chatColumns,
      ['chat_identifier', 'guid'],
      'guid',
    );
    const displayNameColumn = pickFirst(
      chatColumns,
      ['display_name'],
      'display_name',
    );

    const rows = db
      .prepare(
        `
          SELECT
            message.ROWID AS rowId,
            message.guid AS guid,
            message.${textColumn} AS text,
            message.${serviceColumn} AS service,
            message.${fromMeColumn} AS isFromMe,
            message.${dateColumn} AS date,
            handle.id AS handleId,
            chat.guid AS chatGuid,
            chat.${chatIdentifierColumn} AS chatIdentifier,
            chat.${displayNameColumn} AS displayName,
            GROUP_CONCAT(DISTINCT participant.id, char(31)) AS participants
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
      service?: string | null;
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
          service: row.service,
          isFromMe: !!row.isFromMe,
          date: row.date,
          handleId: row.handleId,
          chatGuid: row.chatGuid,
          chatIdentifier: row.chatIdentifier,
          displayName: row.displayName,
          participants: decodeParticipants(row.participants),
        } satisfies RawIMessageMessageRecord),
      )
      .filter((value): value is NonNullable<typeof value> => !!value);

    return {
      messages,
      maxRowId: rows.reduce((acc, row) => Math.max(acc, row.rowId), afterRowId),
    };
  } finally {
    db.close();
  }
}
