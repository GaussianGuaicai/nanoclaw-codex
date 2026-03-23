import { describe, expect, it } from 'vitest';

import {
  normalizeChatRecord,
  normalizeMessageRecord,
  stableChatIdFromParts,
  targetFromChat,
} from './normalize.js';

describe('iMessage normalization', () => {
  it('builds backend-independent direct-message stable ids', () => {
    expect(
      stableChatIdFromParts({
        chatGuid: 'iMessage;+15551234567',
        participants: ['+15551234567'],
      }),
    ).toBe('dm:+15551234567');
  });

  it('builds chat stable ids for group-style guids', () => {
    expect(
      stableChatIdFromParts({
        chatGuid: 'iMessage;-;chat1234567890',
        participants: ['+15551234567', '+15559876543'],
      }),
    ).toBe('chat:chat1234567890');
  });

  it('produces handle targets for direct chats', () => {
    expect(
      targetFromChat({
        stableChatId: 'dm:+15551234567',
        chatIdentifier: '+15551234567',
        participants: ['+15551234567'],
      }),
    ).toEqual({ kind: 'handle', value: '+15551234567' });
  });

  it('normalizes chat metadata into imessage jids', () => {
    const metadata = normalizeChatRecord({
      rowId: 1,
      chatGuid: 'iMessage;+15551234567',
      chatIdentifier: '+15551234567',
      displayName: 'Alice',
      lastMessageDate: 1_000_000_000,
      participants: ['+15551234567'],
    });

    expect(metadata.jid).toBe('imessage:dm:+15551234567');
    expect(metadata.name).toBe('Alice');
    expect(metadata.isGroup).toBe(false);
  });

  it('normalizes inbound messages to NewMessage records', () => {
    const normalized = normalizeMessageRecord({
      rowId: 42,
      guid: 'message-guid',
      text: 'hello',
      service: 'iMessage',
      isFromMe: false,
      date: 1_000_000_000,
      handleId: '+15551234567',
      chatGuid: 'iMessage;+15551234567',
      chatIdentifier: '+15551234567',
      displayName: 'Alice',
      participants: ['+15551234567'],
    });

    expect(normalized?.message.chat_jid).toBe('imessage:dm:+15551234567');
    expect(normalized?.message.sender).toBe('+15551234567');
    expect(normalized?.checkpointRowId).toBe(42);
  });
});
