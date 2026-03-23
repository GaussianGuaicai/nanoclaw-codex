import os from 'os';

import { readEnvFile } from '../../env.js';
import { NewMessage } from '../../types.js';

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
  startPolling(): Promise<void>;
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

  const pollIntervalMs = Math.max(250, parseInt(pollRaw || '1500', 10) || 1500);
  const dbPath = expandHome(dbPathRaw || '~/Library/Messages/chat.db');

  return {
    enabled: enabledRaw === 'true',
    backend,
    pollIntervalMs,
    dbPath,
  };
}

export function jidForStableChatId(stableChatId: string): string {
  return `imessage:${stableChatId}`;
}
