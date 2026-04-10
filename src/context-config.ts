import fs from 'fs';

import { z } from 'zod';

import { CONTEXT_CONFIG_PATH } from './config.js';
import { ContextConfig } from './types.js';

const reasoningEffortSchema = z.enum([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]);

export const partialContextConfigSchema = z.object({
  enabled: z.boolean().optional(),
  summaryMemory: z
    .object({
      enabled: z.boolean().optional(),
      model: z.string().min(1).optional(),
      reasoningEffort: reasoningEffortSchema.optional(),
      updateMinTurns: z.number().int().min(1).optional(),
      maxItemsPerList: z.number().int().min(1).max(50).optional(),
    })
    .partial()
    .optional(),
  compaction: z
    .object({
      enabled: z.boolean().optional(),
      strategy: z.literal('sliding-window').optional(),
      trigger: z
        .object({
          lastInputTokensGte: z.number().int().min(1).optional(),
          fallbackEstimatedTokensGte: z.number().int().min(1).optional(),
        })
        .partial()
        .optional(),
      window: z
        .object({
          keepRecentTurns: z.number().int().min(1).optional(),
          keepRecentEstimatedTokens: z.number().int().min(1).optional(),
        })
        .partial()
        .optional(),
      restartSessionAfterCompact: z.boolean().optional(),
    })
    .partial()
    .optional(),
  sources: z
    .object({
      chat: z.boolean().optional(),
      scheduledGroupContext: z.boolean().optional(),
      websocketGroupContext: z.boolean().optional(),
      isolatedTasks: z.boolean().optional(),
    })
    .partial()
    .optional(),
});

const defaultContextConfig: ContextConfig = {
  enabled: false,
  summaryMemory: {
    enabled: true,
    model: 'gpt-5.4-mini',
    reasoningEffort: 'low',
    updateMinTurns: 2,
    maxItemsPerList: 12,
  },
  compaction: {
    enabled: true,
    strategy: 'sliding-window',
    trigger: {
      lastInputTokensGte: 45000,
      fallbackEstimatedTokensGte: 38000,
    },
    window: {
      keepRecentTurns: 24,
      keepRecentEstimatedTokens: 12000,
    },
    restartSessionAfterCompact: true,
  },
  sources: {
    chat: true,
    scheduledGroupContext: true,
    websocketGroupContext: true,
    isolatedTasks: false,
  },
};

let cachedConfig: ContextConfig | null = null;
let cachedPath: string | null = null;

export function getDefaultContextConfig(): ContextConfig {
  return structuredClone(defaultContextConfig);
}

export function parseContextConfig(input: unknown): ContextConfig {
  const parsed = partialContextConfigSchema.parse(input);
  return mergeContextConfig(defaultContextConfig, parsed);
}

export function mergeContextConfig(
  base: ContextConfig,
  patch: z.infer<typeof partialContextConfigSchema>,
): ContextConfig {
  return {
    enabled: patch.enabled ?? base.enabled,
    summaryMemory: {
      ...base.summaryMemory,
      ...patch.summaryMemory,
    },
    compaction: {
      ...base.compaction,
      ...patch.compaction,
      trigger: {
        ...base.compaction.trigger,
        ...patch.compaction?.trigger,
      },
      window: {
        ...base.compaction.window,
        ...patch.compaction?.window,
      },
    },
    sources: {
      ...base.sources,
      ...patch.sources,
    },
  };
}

export function loadContextConfig(
  configPath = CONTEXT_CONFIG_PATH,
): ContextConfig {
  if (cachedConfig && cachedPath === configPath) {
    return cachedConfig;
  }

  if (!fs.existsSync(configPath)) {
    cachedConfig = getDefaultContextConfig();
    cachedPath = configPath;
    return cachedConfig;
  }

  const raw = fs.readFileSync(configPath, 'utf-8');
  const parsed = raw.trim() ? JSON.parse(raw) : {};
  cachedConfig = parseContextConfig(parsed);
  cachedPath = configPath;
  return cachedConfig;
}

export function resetContextConfigCache(): void {
  cachedConfig = null;
  cachedPath = null;
}
