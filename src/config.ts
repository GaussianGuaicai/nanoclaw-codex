import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets are NOT read here — they stay on disk and are loaded only
// where needed (container-runner.ts) to avoid leaking to child processes.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'NANOCLAW_CODEX_AUTH_SOURCE_DIR',
  'NANOCLAW_CODEX_AUTH_AUTOREPAIR',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for runtime state and local sandbox preparation
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never exposed to workers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const WEBSOCKET_SOURCES_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'websocket-sources.json',
);
export const AGENT_CONFIG_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'agent-config.json',
);
export const GROUP_SECRETS_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'group-secrets.json',
);
export const CODEX_AUTH_SOURCE_DIR =
  process.env.NANOCLAW_CODEX_AUTH_SOURCE_DIR ||
  envConfig.NANOCLAW_CODEX_AUTH_SOURCE_DIR ||
  path.join(HOME_DIR, '.config', 'nanoclaw', 'codex-auth');
export const CODEX_AUTH_AUTOREPAIR =
  (
    process.env.NANOCLAW_CODEX_AUTH_AUTOREPAIR ||
    envConfig.NANOCLAW_CODEX_AUTH_AUTOREPAIR ||
    'true'
  ).toLowerCase() !== 'false';
export const CONTEXT_CONFIG_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'context-config.json',
);
export const LOGS_DIR = path.resolve(PROJECT_ROOT, 'logs');
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const AGENT_TIMEOUT = parseInt(
  process.env.NANOCLAW_AGENT_TIMEOUT ||
    process.env.CONTAINER_TIMEOUT ||
    '1800000',
  10,
);
export const AGENT_MAX_OUTPUT_SIZE = parseInt(
  process.env.NANOCLAW_AGENT_MAX_OUTPUT_SIZE ||
    process.env.CONTAINER_MAX_OUTPUT_SIZE ||
    '10485760',
  10,
); // 10MB default
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep worker alive after last result
export const MAX_CONCURRENT_AGENTS = Math.max(
  1,
  parseInt(
    process.env.MAX_CONCURRENT_AGENTS ||
      process.env.MAX_CONCURRENT_CONTAINERS ||
      '5',
    10,
  ) || 5,
);

// Deprecated compatibility aliases. Remove after downstream callers migrate.
export const CONTAINER_TIMEOUT = AGENT_TIMEOUT;
export const CONTAINER_MAX_OUTPUT_SIZE = AGENT_MAX_OUTPUT_SIZE;
export const MAX_CONCURRENT_CONTAINERS = MAX_CONCURRENT_AGENTS;

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
