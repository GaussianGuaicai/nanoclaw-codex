import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseBlueBubblesInboundPayload } from './bluebubbles-adapter.js';

describe('parseBlueBubblesInboundPayload', () => {
  const fixturesDir = path.resolve(__dirname, 'fixtures');

  function readFixture(name: string): unknown {
    return JSON.parse(fs.readFileSync(path.join(fixturesDir, name), 'utf-8'));
  }

  it('parses webhook payload fixture into inbound event', () => {
    const payload = readFixture('bluebubbles-webhook-message.json');
    const event = parseBlueBubblesInboundPayload(payload, 'webhook');

    expect(event).not.toBeNull();
    expect(event?.platformMessageId).toBe('msg-123');
    expect(event?.chatId).toBe('iMessage;+;chat123');
    expect(event?.sender).toBe('+15550001111');
    expect(event?.senderName).toBe('Alice');
    expect(event?.content).toBe('hello from webhook');
    expect(event?.messageType).toBe('text');
  });

  it('parses websocket payload fixture into inbound event', () => {
    const payload = readFixture('bluebubbles-websocket-message.json');
    const event = parseBlueBubblesInboundPayload(payload, 'websocket');

    expect(event).not.toBeNull();
    expect(event?.platformMessageId).toBe('msg-456');
    expect(event?.chatId).toBe('iMessage;+;chat456');
    expect(event?.sender).toBe('+15550002222');
    expect(event?.senderName).toBe('Bob');
    expect(event?.messageType).toBe('image');
    expect(event?.content).toBe('photo here');
  });

  it('returns null for invalid payload without ids', () => {
    const event = parseBlueBubblesInboundPayload({ hello: 'world' }, 'webhook');
    expect(event).toBeNull();
  });
});
