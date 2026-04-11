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

import fs from 'fs';

import { readEnvFile } from '../env.js';
import { getChannelFactory } from './registry.js';
import {
  getIMessageConfig,
  IMessageChannel,
  stableChatIdFromParts,
  targetFromChat,
} from './imessage.js';

describe('iMessage single-file channel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readEnvFile).mockReturnValue({});
    vi.mocked(fs.existsSync).mockReturnValue(true);
    state.clear();
    delete process.env.IMESSAGE_ENABLED;
    delete process.env.IMESSAGE_BACKEND;
    delete process.env.IMESSAGE_POLL_INTERVAL_MS;
    delete process.env.IMESSAGE_DB_PATH;
  });

  it('defaults backend to local-macos and expands db path', () => {
    process.env.IMESSAGE_ENABLED = 'true';
    const config = getIMessageConfig();
    expect(config.backend).toBe('local-macos');
    expect(config.pollIntervalMs).toBe(1500);
    expect(config.dbPath).toContain('/Library/Messages/chat.db');
  });

  it('accepts bluebubbles backend via env', () => {
    process.env.IMESSAGE_ENABLED = 'true';
    process.env.IMESSAGE_BACKEND = 'bluebubbles';
    const config = getIMessageConfig();
    expect(config.backend).toBe('bluebubbles');
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
      },
    });
    expect(channel.ownsJid('imessage:dm:+15551234567')).toBe(true);
    expect(channel.ownsJid('slack:C1')).toBe(false);
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
