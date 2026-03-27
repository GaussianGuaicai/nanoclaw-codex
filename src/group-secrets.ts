import fs from 'fs';

import { z } from 'zod';

import { GROUP_SECRETS_PATH } from './config.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const groupSecretEntrySchema = z.object({
  env: z.record(z.string(), z.string()).default({}),
});

const groupSecretsConfigSchema = z.object({
  version: z.literal(1),
  groups: z.record(z.string(), groupSecretEntrySchema).default({}),
});

export type GroupSecretsConfig = z.infer<typeof groupSecretsConfigSchema>;

const EMPTY_GROUP_SECRETS_CONFIG: GroupSecretsConfig = {
  version: 1,
  groups: {},
};

export function loadGroupSecretsConfig(): GroupSecretsConfig {
  if (!fs.existsSync(GROUP_SECRETS_PATH)) {
    logger.debug(
      { path: GROUP_SECRETS_PATH },
      'Group secrets config not found, skipping',
    );
    return EMPTY_GROUP_SECRETS_CONFIG;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(GROUP_SECRETS_PATH, 'utf-8'));
    const parsed = groupSecretsConfigSchema.safeParse(raw);
    if (!parsed.success) {
      logger.error(
        { path: GROUP_SECRETS_PATH, issues: parsed.error.issues },
        'Invalid group secrets config',
      );
      return EMPTY_GROUP_SECRETS_CONFIG;
    }

    return parsed.data;
  } catch (err) {
    logger.error(
      { path: GROUP_SECRETS_PATH, err },
      'Failed to read group secrets config',
    );
    return EMPTY_GROUP_SECRETS_CONFIG;
  }
}

export function resolveGroupWorkerEnv(groupFolder: string): Record<string, string> {
  const config = loadGroupSecretsConfig();
  const groupConfig = config.groups[groupFolder];
  if (!groupConfig) {
    return {};
  }

  const managedKeys = Object.keys(groupConfig.env);
  if (managedKeys.length === 0) {
    return {};
  }

  const globalEnv = readEnvFile(managedKeys);
  const resolved: Record<string, string> = { ...globalEnv };

  for (const [key, value] of Object.entries(groupConfig.env)) {
    if (value === '') {
      continue;
    }
    resolved[key] = value;
  }

  return resolved;
}
