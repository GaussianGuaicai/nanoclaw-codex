import fs from 'fs';
import path from 'path';

import { z } from 'zod';

import { agentExecutionSourceConfigSchema } from './agent-config.js';
import {
  mergeContextConfig,
  partialContextConfigSchema,
} from './context-config.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  AgentExecutionSourceConfig,
  ContextConfig,
  RegisteredGroup,
} from './types.js';

const workerConfigSchema = z
  .object({
    agent: agentExecutionSourceConfigSchema.optional(),
    context: partialContextConfigSchema.optional(),
  })
  .strict();

export type WorkerConfig = z.infer<typeof workerConfigSchema>;

export function getWorkerConfigPath(groupFolder: string): string {
  return path.join(
    resolveGroupFolderPath(groupFolder),
    'config',
    'worker-config.json',
  );
}

export function getWorkerWebSocketSourcesPath(groupFolder: string): string {
  return path.join(
    resolveGroupFolderPath(groupFolder),
    'config',
    'websocket-sources.json',
  );
}

export function loadWorkerConfig(groupFolder: string): WorkerConfig | null {
  const configPath = getWorkerConfigPath(groupFolder);
  if (!fs.existsSync(configPath)) return null;

  try {
    const raw = fs.readFileSync(configPath, 'utf-8').trim();
    if (!raw) return null;
    return workerConfigSchema.parse(JSON.parse(raw));
  } catch (err) {
    logger.warn(
      { groupFolder, path: configPath, err },
      'Ignoring invalid worker-owned config',
    );
    return null;
  }
}

export function loadWorkerAgentConfig(
  groupFolder?: string,
): AgentExecutionSourceConfig | undefined {
  if (!groupFolder) return undefined;
  return loadWorkerConfig(groupFolder)?.agent;
}

export function mergeWorkerContextConfig(
  base: ContextConfig,
  groupFolder?: string,
): ContextConfig {
  if (!groupFolder) return base;
  const patch = loadWorkerConfig(groupFolder)?.context;
  return patch ? mergeContextConfig(base, patch) : base;
}

export function startWorkerConfigWatcher(options: {
  registeredGroups: () => Record<string, RegisteredGroup>;
  onChange: () => Promise<void>;
  pollMs?: number;
}): () => void {
  const pollMs = options.pollMs ?? 2000;
  const lastSeen = new Map<string, string>();
  let initialized = false;
  let reloadInFlight = false;

  const readStamp = (groupFolder: string): string => {
    const paths = [
      getWorkerConfigPath(groupFolder),
      getWorkerWebSocketSourcesPath(groupFolder),
    ];
    return paths
      .map((configPath) => {
        try {
          return String(fs.statSync(configPath).mtimeMs);
        } catch {
          return 'missing';
        }
      })
      .join(':');
  };

  const poll = () => {
    const groups = Object.values(options.registeredGroups());
    let changed = false;

    for (const group of groups) {
      const stamp = readStamp(group.folder);
      if (!lastSeen.has(group.folder)) {
        lastSeen.set(group.folder, stamp);
        if (initialized && stamp !== 'missing:missing') {
          changed = true;
        }
        continue;
      }
      if (lastSeen.get(group.folder) !== stamp) {
        lastSeen.set(group.folder, stamp);
        changed = true;
      }
    }

    for (const groupFolder of [...lastSeen.keys()]) {
      if (!groups.some((group) => group.folder === groupFolder)) {
        lastSeen.delete(groupFolder);
      }
    }

    if (!initialized) {
      initialized = true;
      return;
    }
    if (!changed || reloadInFlight) return;

    reloadInFlight = true;
    options
      .onChange()
      .catch((err) => {
        logger.warn({ err }, 'Worker-owned config reload failed');
      })
      .finally(() => {
        reloadInFlight = false;
      });
  };

  poll();
  const timer = setInterval(poll, pollMs);
  return () => clearInterval(timer);
}
