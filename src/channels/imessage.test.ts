import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
  },
}));

vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(),
}));

const state = new Map<string, string>();
vi.mock('../db.js', () => ({
  getRouterState: vi.fn((key: string) => state.get(key)),
  setRouterState: vi.fn((key: string, value: string) => {
    state.set(key, value);
  }),
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

let messageRows: Array<Record<string, unknown>> = [];
const fakeDb = {
  prepare: vi.fn((sql: string) => ({
    all: vi.fn(() => {
      if (sql.includes('PRAGMA table_info(message)')) {
        return [
          { name: 'text' },
          { name: 'is_from_me' },
          { name: 'date' },
          { name: 'handle_id' },
          { name: 'attributedBody' },
        ];
      }
      if (sql.includes('PRAGMA table_info(chat)')) {
        return [{ name: 'chat_identifier' }, { name: 'display_name' }];
      }
      if (sql.includes('FROM message')) return messageRows;
      return [];
    }),
    get: vi.fn(() => {
      if (sql.includes('sqlite_master')) return { name: 'chat_message_join' };
      if (sql.includes('MAX(ROWID)')) return { maxRowId: 0 };
      return undefined;
    }),
  })),
  close: vi.fn(),
};

vi.mock('better-sqlite3', () => ({
  default: vi.fn(function Database() {
    return fakeDb;
  }),
}));

import fs from 'fs';

import { readEnvFile } from '../env.js';
import { getChannelFactory } from './registry.js';
import {
  extractTextFromAttributedBody,
  getIMessageConfig,
  IMessageChannel,
  LocalMacOSIMessageBackend,
  isAllowedContact,
  isValidIMessageTarget,
  parseAllowedContacts,
  resolveMessageContent,
  shouldDispatchInboundMessage,
  stableChatIdFromParts,
  targetFromChat,
} from './imessage.js';

describe('iMessage single-file channel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readEnvFile).mockReturnValue({});
    vi.mocked(fs.existsSync).mockReturnValue(true);
    messageRows = [];
    state.clear();
    delete process.env.IMESSAGE_ENABLED;
    delete process.env.IMESSAGE_BACKEND;
    delete process.env.IMESSAGE_POLL_INTERVAL_MS;
    delete process.env.IMESSAGE_DB_PATH;
    delete process.env.IMESSAGE_ALLOWED_CONTACTS;
  });

  it('defaults backend to local-macos and expands db path', () => {
    process.env.IMESSAGE_ENABLED = 'true';
    const config = getIMessageConfig();
    expect(config.backend).toBe('local-macos');
    expect(config.pollIntervalMs).toBe(1500);
    expect(config.dbPath).toContain('/Library/Messages/chat.db');
    expect(config.allowedContacts).toEqual([]);
  });

  it('accepts bluebubbles backend via env', () => {
    process.env.IMESSAGE_ENABLED = 'true';
    process.env.IMESSAGE_BACKEND = 'bluebubbles';
    const config = getIMessageConfig();
    expect(config.backend).toBe('bluebubbles');
  });

  it('parses IMESSAGE_ALLOWED_CONTACTS with wildcard and normalization', () => {
    process.env.IMESSAGE_ENABLED = 'true';
    process.env.IMESSAGE_ALLOWED_CONTACTS =
      ' +15551234567 , USER@Example.com , *, , mailto:foo@bar.com ';
    const config = getIMessageConfig();
    expect(config.allowedContacts).toEqual([
      '+15551234567',
      'user@example.com',
      '*',
      'foo@bar.com',
    ]);
  });

  it('builds stable ids and targets compatibly', () => {
    expect(
      stableChatIdFromParts({
        chatGuid: 'iMessage;+15551234567',
        participants: ['+15551234567'],
      }),
    ).toBe('dm:+15551234567');
    expect(
      stableChatIdFromParts({
        chatGuid: 'iMessage;-;chat1234567890',
        participants: ['+15551234567', '+15559876543'],
      }),
    ).toBe('chat:chat1234567890');
    expect(
      targetFromChat({
        stableChatId: 'dm:+15551234567',
        chatIdentifier: '+15551234567',
        participants: ['+15551234567'],
      }),
    ).toEqual({ kind: 'handle', value: '+15551234567' });
  });

  it('persists checkpoint via router_state without parse failures', () => {
    process.env.IMESSAGE_ENABLED = 'true';
    const channel = new IMessageChannel({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
      backend: {
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        isConnected: vi.fn().mockReturnValue(true),
        sendText: vi.fn().mockResolvedValue(undefined),
        syncChats: vi.fn().mockResolvedValue(undefined),
      },
      config: {
        enabled: true,
        backend: 'local-macos',
        pollIntervalMs: 1500,
        dbPath: '/tmp/chat.db',
        allowedContacts: [],
      },
    });
    expect(channel.ownsJid('imessage:dm:+15551234567')).toBe(true);
    expect(channel.ownsJid('slack:C1')).toBe(false);
  });

  it('parses allowlist values deterministically', () => {
    expect(parseAllowedContacts(undefined)).toEqual([]);
    expect(parseAllowedContacts('')).toEqual([]);
    expect(
      parseAllowedContacts(' *, +15551234567,USER@EXAMPLE.COM, +15551234567 '),
    ).toEqual(['*', '+15551234567', 'user@example.com']);
  });

  it('matches contacts against allowlist semantics', () => {
    expect(isAllowedContact(['*'], 'anyone')).toBe(true);
    expect(
      isAllowedContact(['+15551234567', 'user@example.com'], '+15551234567'),
    ).toBe(true);
    expect(
      isAllowedContact(
        ['+15551234567', 'user@example.com'],
        'USER@EXAMPLE.COM',
      ),
    ).toBe(true);
    expect(isAllowedContact(['+15551234567'], '+19999999999')).toBe(false);
    expect(isAllowedContact([], '+15551234567')).toBe(false);
  });

  it('checks inbound dispatch order: deny by allowlist before registered lookup', () => {
    const isRegisteredJid = vi.fn().mockReturnValue(true);
    const denied = shouldDispatchInboundMessage({
      isFromMe: false,
      sender: '+19999999999',
      jid: 'imessage:dm:+19999999999',
      allowedContacts: ['+15551234567'],
      isRegisteredJid,
    });
    expect(denied).toBe(false);
    expect(isRegisteredJid).not.toHaveBeenCalled();

    const allowedButUnregistered = shouldDispatchInboundMessage({
      isFromMe: false,
      sender: '+15551234567',
      jid: 'imessage:dm:+15551234567',
      allowedContacts: ['+15551234567'],
      isRegisteredJid: () => false,
    });
    expect(allowedButUnregistered).toBe(false);

    const fullyAllowed = shouldDispatchInboundMessage({
      isFromMe: false,
      sender: '+15551234567',
      jid: 'imessage:dm:+15551234567',
      allowedContacts: ['+15551234567'],
      isRegisteredJid: () => true,
    });
    expect(fullyAllowed).toBe(true);
  });

  it('skips overlapping local-macos polls while one is in flight', async () => {
    messageRows = [
      {
        rowId: 1,
        guid: 'message-1',
        text: 'hello',
        attributedBody: null,
        isFromMe: 0,
        date: 1,
        handleId: '+15551234567',
        chatGuid: 'iMessage;+15551234567',
        chatIdentifier: '+15551234567',
        displayName: null,
        participants: '+15551234567',
      },
    ];

    let attemptedReentry = false;
    const backend = new LocalMacOSIMessageBackend(
      {
        enabled: true,
        backend: 'local-macos',
        pollIntervalMs: 1500,
        dbPath: '/tmp/chat.db',
        allowedContacts: ['*'],
      },
      {
        onChatMetadata: vi.fn(),
        onMessage: vi.fn(() => {
          if (attemptedReentry) return;
          attemptedReentry = true;
          void (
            backend as unknown as { pollOnce: () => Promise<void> }
          ).pollOnce();
        }),
        isRegisteredJid: () => true,
      },
    );

    (
      backend as unknown as {
        connected: boolean;
        pollOnce: () => Promise<void>;
      }
    ).connected = true;

    await (
      backend as unknown as {
        pollOnce: () => Promise<void>;
      }
    ).pollOnce();

    expect(attemptedReentry).toBe(true);
    expect(
      (
        backend as unknown as {
          callbacks: { onMessage: ReturnType<typeof vi.fn> };
        }
      ).callbacks.onMessage,
    ).toHaveBeenCalledTimes(1);
  });

  it('parses attributedBody fallback and keeps text precedence', () => {
    const text = 'Hello from attributedBody';
    const bytes = new TextEncoder().encode(text);
    const blob = Uint8Array.from([
      0x01,
      0x2b,
      bytes.length,
      ...bytes,
      0x86,
      0x84,
    ]);

    expect(extractTextFromAttributedBody(blob)).toBe(text);
    expect(resolveMessageContent(1, null, blob)).toBe(text);
    expect(resolveMessageContent(1, 'Plain text wins', blob)).toBe(
      'Plain text wins',
    );
    expect(resolveMessageContent(1, '', Uint8Array.from([0x01, 0x2b]))).toBe(
      '',
    );
  });

  it('validates outbound iMessage targets for handle mode safety', () => {
    expect(isValidIMessageTarget('+15551234567')).toBe(true);
    expect(isValidIMessageTarget('user@example.com')).toBe(true);
    expect(isValidIMessageTarget('bad target')).toBe(false);
    expect(isValidIMessageTarget('')).toBe(false);
  });

  it('factory skips bluebubbles backend cleanly', () => {
    process.env.IMESSAGE_ENABLED = 'true';
    process.env.IMESSAGE_BACKEND = 'bluebubbles';
    const factory = getChannelFactory('imessage');
    expect(factory).toBeDefined();
    const result = factory!({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });
    expect(result).toBeNull();
  });

  it('factory skips local-macos on non-darwin host', () => {
    process.env.IMESSAGE_ENABLED = 'true';
    process.env.IMESSAGE_BACKEND = 'local-macos';
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });

    const factory = getChannelFactory('imessage');
    const result = factory!({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });
    expect(result).toBeNull();

    Object.defineProperty(process, 'platform', { value: original });
  });

  it('factory skips when DB path does not exist', () => {
    process.env.IMESSAGE_ENABLED = 'true';
    process.env.IMESSAGE_BACKEND = 'local-macos';
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin' });

    const factory = getChannelFactory('imessage');
    const result = factory!({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });
    expect(result).toBeNull();

    Object.defineProperty(process, 'platform', { value: original });
  });
});
