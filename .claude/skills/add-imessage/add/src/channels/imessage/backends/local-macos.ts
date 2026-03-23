import fs from 'fs';

import { logger } from '../../../logger.js';
import {
  IMessageBackend,
  IMessageBackendCallbacks,
  IMessageChatMetadata,
  IMessageConfig,
  IMessageChatTarget,
} from '../backend.js';
import { sendTextViaAppleScript } from '../local/applescript.js';
import {
  loadIMessageCheckpoint,
  saveIMessageCheckpoint,
} from '../local/checkpoint.js';
import { readMessagesSince, readRecentChats } from '../local/chat-db.js';

export class LocalMacOSIMessageBackend implements IMessageBackend {
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

    this.connected = true;
    await this.syncChats(true);
    await this.startPolling();
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
    if (!force && now - this.lastSyncAt < 30_000) {
      return;
    }

    try {
      const result = readRecentChats(this.config.dbPath, 50);
      for (const metadata of result.chats) {
        this.rememberMetadata(metadata);
        this.callbacks.onChatMetadata(metadata);
      }
      this.lastSyncAt = now;
    } catch (error) {
      logger.error(
        { error },
        'Failed to sync iMessage chats from local macOS backend',
      );
    }
  }

  async startPolling(): Promise<void> {
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
        this.rememberMetadata(entry.metadata);
        this.callbacks.onChatMetadata(entry.metadata);
        if (this.callbacks.isRegisteredJid(entry.jid)) {
          this.callbacks.onMessage({
            jid: entry.jid,
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

  private rememberMetadata(metadata: IMessageChatMetadata): void {
    this.chatTargets.set(metadata.stableChatId, metadata.target);
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
