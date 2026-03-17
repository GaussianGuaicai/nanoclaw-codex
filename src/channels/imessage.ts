import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { ASSISTANT_NAME } from '../config.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';

const execFileAsync = promisify(execFile);

interface IMessageConfig {
  account: string;
}

interface IMessageChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class IMessageChannel implements Channel {
  name = 'imessage';

  private connected = false;
  private readonly opts: IMessageChannelOpts;
  private readonly config: IMessageConfig;

  constructor(config: IMessageConfig, opts: IMessageChannelOpts) {
    this.config = config;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    if (process.platform !== 'darwin') {
      logger.warn('iMessage channel is only supported on macOS');
      return;
    }

    this.connected = true;
    logger.info({ account: this.config.account }, 'iMessage channel connected');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.connected) {
      logger.warn({ jid }, 'iMessage channel not connected, skipping send');
      return;
    }

    const chatId = jid.replace(/^im:/, '');

    try {
      await this.sendViaAppleScript(chatId, text);
      logger.info({ jid, length: text.length }, 'iMessage message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send iMessage message');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('im:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    logger.info('iMessage channel disconnected');
  }

  // Inbound delivery hook reserved for bridge/poller implementations.
  // Keeps the same callback flow as other channels: metadata first, then message.
  handleInboundMessage(chatId: string, sender: string, content: string): void {
    const jid = `im:${chatId}`;
    const timestamp = new Date().toISOString();

    this.opts.onChatMetadata(jid, timestamp, undefined, 'imessage', true);

    const groups = this.opts.registeredGroups();
    if (!groups[jid]) return;

    this.opts.onMessage(jid, {
      id: `${Date.now()}`,
      chat_jid: jid,
      sender,
      sender_name: sender,
      content,
      timestamp,
      is_from_me: sender === this.config.account,
      is_bot_message:
        sender === this.config.account || sender === ASSISTANT_NAME,
    });
  }

  private async sendViaAppleScript(
    chatId: string,
    text: string,
  ): Promise<void> {
    const escapedChatId = escapeAppleScriptString(chatId);
    const escapedText = escapeAppleScriptString(text);

    await execFileAsync('osascript', [
      '-e',
      'tell application "Messages"',
      '-e',
      `set targetChat to text chat id "${escapedChatId}"`,
      '-e',
      `send "${escapedText}" to targetChat`,
      '-e',
      'end tell',
    ]);
  }
}

function escapeAppleScriptString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

registerChannel('imessage', (opts: ChannelOpts) => {
  const env = readEnvFile(['IMESSAGE_ACCOUNT']);
  const account = process.env.IMESSAGE_ACCOUNT || env.IMESSAGE_ACCOUNT || '';

  if (!account) {
    logger.warn('iMessage: IMESSAGE_ACCOUNT not set');
    return null;
  }

  return new IMessageChannel({ account }, opts);
});
