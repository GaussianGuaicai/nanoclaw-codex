import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(true),
  },
}));

vi.mock('../../../logger.js', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('../local/checkpoint.js', () => ({
  loadIMessageCheckpoint: vi.fn().mockReturnValue({
    lastRowId: 0,
    updatedAt: '1970-01-01T00:00:00.000Z',
  }),
  saveIMessageCheckpoint: vi.fn((rowId: number) => ({
    lastRowId: rowId,
    updatedAt: '2024-01-01T00:00:00.000Z',
  })),
}));

vi.mock('../local/chat-db.js', () => ({
  readLatestMessageRowId: vi.fn().mockReturnValue(50),
  readRecentChats: vi.fn().mockReturnValue({
    chats: [
      {
        jid: 'imessage:dm:+15551234567',
        stableChatId: 'dm:+15551234567',
        name: 'Alice',
        timestamp: '2024-01-01T00:00:00.000Z',
        isGroup: false,
        target: { kind: 'handle', value: '+15551234567' },
      },
    ],
  }),
  readMessagesSince: vi.fn().mockReturnValue({
    messages: [
      {
        jid: 'imessage:dm:+15551234567',
        stableChatId: 'dm:+15551234567',
        metadata: {
          jid: 'imessage:dm:+15551234567',
          stableChatId: 'dm:+15551234567',
          name: 'Alice',
          timestamp: '2024-01-01T00:00:00.000Z',
          isGroup: false,
          target: { kind: 'handle', value: '+15551234567' },
        },
        message: {
          id: 'm1',
          chat_jid: 'imessage:dm:+15551234567',
          sender: '+15551234567',
          sender_name: 'Alice',
          content: 'hello',
          timestamp: '2024-01-01T00:00:00.000Z',
          is_from_me: false,
          is_bot_message: false,
        },
      },
    ],
    maxRowId: 50,
  }),
}));

vi.mock('../local/applescript.js', () => ({
  sendTextViaAppleScript: vi.fn().mockResolvedValue(undefined),
}));

import { LocalMacOSIMessageBackend } from './local-macos.js';
import { sendTextViaAppleScript } from '../local/applescript.js';
import { readLatestMessageRowId, readMessagesSince } from '../local/chat-db.js';

describe('LocalMacOSIMessageBackend', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      'setInterval',
      vi.fn(() => 1 as unknown as NodeJS.Timeout),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('syncs chats and only delivers registered inbound messages', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });

    const callbacks = {
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      isRegisteredJid: vi.fn().mockReturnValue(true),
    };

    const backend = new LocalMacOSIMessageBackend(
      {
        enabled: true,
        backend: 'local-macos',
        pollIntervalMs: 1500,
        dbPath: '/tmp/chat.db',
      },
      callbacks,
    );

    await backend.connect();

    expect(callbacks.onChatMetadata).toHaveBeenCalled();
    expect(callbacks.onMessage).toHaveBeenCalled();
  });

  it('does not forward self-authored messages to onMessage', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });

    vi.mocked(readLatestMessageRowId).mockReturnValueOnce(0);
    vi.mocked(readMessagesSince).mockReturnValueOnce({
      messages: [
        {
          stableChatId: 'dm:+15551234567',
          metadata: {
            jid: 'imessage:dm:+15551234567',
            stableChatId: 'dm:+15551234567',
            name: 'Alice',
            timestamp: '2024-01-01T00:00:00.000Z',
            isGroup: false,
            target: { kind: 'handle', value: '+15551234567' },
          },
          message: {
            id: 'm2',
            chat_jid: 'imessage:dm:+15551234567',
            sender: 'me',
            sender_name: 'Me',
            content: 'self message',
            timestamp: '2024-01-01T00:00:01.000Z',
            is_from_me: true,
            is_bot_message: false,
          },
          checkpointRowId: 51,
        },
      ],
      maxRowId: 51,
    });

    const callbacks = {
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      isRegisteredJid: vi.fn().mockReturnValue(true),
    };

    const backend = new LocalMacOSIMessageBackend(
      {
        enabled: true,
        backend: 'local-macos',
        pollIntervalMs: 1500,
        dbPath: '/tmp/chat.db',
      },
      callbacks,
    );

    await backend.connect();

    expect(callbacks.onChatMetadata).toHaveBeenCalled();
    expect(callbacks.onMessage).not.toHaveBeenCalled();
  });

  it('uses remembered targets for outbound sends', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });

    const backend = new LocalMacOSIMessageBackend(
      {
        enabled: true,
        backend: 'local-macos',
        pollIntervalMs: 1500,
        dbPath: '/tmp/chat.db',
      },
      {
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
        isRegisteredJid: vi.fn().mockReturnValue(false),
      },
    );

    await backend.connect();
    await backend.sendText('dm:+15551234567', 'hello');

    expect(sendTextViaAppleScript).toHaveBeenCalledWith(
      { kind: 'handle', value: '+15551234567' },
      'hello',
    );
  });
});
