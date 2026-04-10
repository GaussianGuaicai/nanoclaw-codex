import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('./backends/local-macos.js', () => ({
  LocalMacOSIMessageBackend: vi.fn().mockImplementation(function () {
    return {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      isConnected: vi.fn().mockReturnValue(true),
      sendText: vi.fn().mockResolvedValue(undefined),
      syncChats: vi.fn().mockResolvedValue(undefined),
      startPolling: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));

vi.mock('./backends/bluebubbles.js', () => ({
  BlueBubblesBackend: vi.fn().mockImplementation(function () {
    return {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      isConnected: vi.fn().mockReturnValue(false),
      sendText: vi.fn().mockResolvedValue(undefined),
      syncChats: vi.fn().mockResolvedValue(undefined),
      startPolling: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));

import { IMessageChannel } from './channel.js';
import { BlueBubblesBackend } from './backends/bluebubbles.js';
import { LocalMacOSIMessageBackend } from './backends/local-macos.js';

describe('IMessageChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('owns only imessage jids', () => {
    const channel = new IMessageChannel({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
      config: {
        enabled: true,
        backend: 'local-macos',
        pollIntervalMs: 1500,
        dbPath: '/tmp/chat.db',
      },
    });

    expect(channel.ownsJid('imessage:dm:+15551234567')).toBe(true);
    expect(channel.ownsJid('slack:C123')).toBe(false);
  });

  it('selects local-macos backend by default', () => {
    new IMessageChannel({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
      config: {
        enabled: true,
        backend: 'local-macos',
        pollIntervalMs: 1500,
        dbPath: '/tmp/chat.db',
      },
    });

    expect(LocalMacOSIMessageBackend).toHaveBeenCalled();
    expect(BlueBubblesBackend).not.toHaveBeenCalled();
  });

  it('selects bluebubbles backend when configured', () => {
    new IMessageChannel({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
      config: {
        enabled: true,
        backend: 'bluebubbles',
        pollIntervalMs: 1500,
        dbPath: '/tmp/chat.db',
      },
    });

    expect(BlueBubblesBackend).toHaveBeenCalled();
  });

  it('forwards sendMessage through stable chat ids', async () => {
    const sendText = vi.fn().mockResolvedValue(undefined);
    const channel = new IMessageChannel({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
      backend: {
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        isConnected: vi.fn().mockReturnValue(true),
        sendText,
        syncChats: vi.fn().mockResolvedValue(undefined),
        startPolling: vi.fn().mockResolvedValue(undefined),
      },
      config: {
        enabled: true,
        backend: 'local-macos',
        pollIntervalMs: 1500,
        dbPath: '/tmp/chat.db',
      },
    });

    await channel.sendMessage('imessage:dm:+15551234567', 'hello');

    expect(sendText).toHaveBeenCalledWith('dm:+15551234567', 'hello');
  });
});
