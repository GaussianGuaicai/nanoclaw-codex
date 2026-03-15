import fs from 'fs';

import { z } from 'zod';

import { AGENT_CONFIG_PATH } from './config.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import {
  AgentExecutionConfig,
  AgentExecutionConfigScope,
  AgentExecutionSourceConfig,
  AgentTaskSource,
  RegisteredGroup,
} from './types.js';

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const reasoningEffortSchema = z.enum([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]);

export const agentExecutionConfigSchema = z
  .object({
    model: z.string().min(1).optional(),
    reasoningEffort: reasoningEffortSchema.optional(),
    codexConfigOverrides: z.record(z.string(), jsonValueSchema).optional(),
  })
  .refine(
    (v) =>
      v.model !== undefined ||
      v.reasoningEffort !== undefined ||
      v.codexConfigOverrides !== undefined,
    {
      message:
        'Agent execution config must include model, reasoningEffort, or codexConfigOverrides',
    },
  );

export const agentExecutionSourceConfigSchema = z
  .object({
    defaults: agentExecutionConfigSchema.optional(),
    bySource: z
      .object({
        chat: agentExecutionConfigSchema.optional(),
        scheduled: agentExecutionConfigSchema.optional(),
        websocket: agentExecutionConfigSchema.optional(),
      })
      .optional(),
  })
  .refine((v) => v.defaults !== undefined || v.bySource !== undefined, {
    message: 'Agent config must include defaults or bySource',
  });

interface GlobalAgentConfigState {
  valid: boolean;
  config: AgentExecutionSourceConfig | null;
  error?: string;
}

let cachedGlobalConfig: GlobalAgentConfigState | null = null;

function parseErrorMessage(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
}

function mergeConfig(
  base: AgentExecutionConfig,
  next?: AgentExecutionConfig,
): AgentExecutionConfig {
  if (!next) return base;
  const mergedOverrides = {
    ...(base.codexConfigOverrides || {}),
    ...(next.codexConfigOverrides || {}),
  };
  return {
    ...base,
    ...next,
    ...(Object.keys(mergedOverrides).length > 0
      ? { codexConfigOverrides: mergedOverrides }
      : {}),
  };
}

function applySourceLayer(
  current: AgentExecutionConfig,
  source: AgentTaskSource,
  layer?: AgentExecutionSourceConfig | null,
): AgentExecutionConfig {
  if (!layer) return current;
  return mergeConfig(mergeConfig(current, layer.defaults), layer.bySource?.[source]);
}

function readLegacyDefaults(): AgentExecutionConfig {
  const envFile = readEnvFile([
    'NANOCLAW_CODEX_MODEL',
    'NANOCLAW_CODEX_REASONING_EFFORT',
  ]);
  const model = process.env.NANOCLAW_CODEX_MODEL || envFile.NANOCLAW_CODEX_MODEL;
  const reasoningRaw =
    process.env.NANOCLAW_CODEX_REASONING_EFFORT ||
    envFile.NANOCLAW_CODEX_REASONING_EFFORT;

  const config: AgentExecutionConfig = {};
  if (model) config.model = model;
  if (reasoningRaw) {
    const parsedReasoning = reasoningEffortSchema.safeParse(reasoningRaw);
    if (parsedReasoning.success) {
      config.reasoningEffort = parsedReasoning.data;
    } else {
      logger.warn(
        { value: reasoningRaw },
        'Ignoring invalid legacy NANOCLAW_CODEX_REASONING_EFFORT',
      );
    }
  }
  return config;
}

function loadGlobalConfigOnce(): GlobalAgentConfigState {
  if (!fs.existsSync(AGENT_CONFIG_PATH)) {
    return { valid: true, config: null };
  }

  try {
    const parsed = agentExecutionSourceConfigSchema.safeParse(
      JSON.parse(fs.readFileSync(AGENT_CONFIG_PATH, 'utf-8')),
    );
    if (!parsed.success) {
      const error = parseErrorMessage(parsed.error);
      logger.error(
        { path: AGENT_CONFIG_PATH, error },
        'Invalid global agent config; agent execution disabled',
      );
      return { valid: false, config: null, error };
    }
    return { valid: true, config: parsed.data };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error(
      { path: AGENT_CONFIG_PATH, err: error },
      'Failed to load global agent config; agent execution disabled',
    );
    return { valid: false, config: null, error };
  }
}

export function initializeGlobalAgentConfig(): GlobalAgentConfigState {
  if (!cachedGlobalConfig) {
    cachedGlobalConfig = loadGlobalConfigOnce();
  }
  return cachedGlobalConfig;
}

export function resetGlobalAgentConfigForTests(): void {
  cachedGlobalConfig = null;
}

function parseScoped<T>(
  schema: z.ZodType<T>,
  value: unknown,
  scope: AgentExecutionConfigScope,
): { ok: true; value?: T } | { ok: false; scope: AgentExecutionConfigScope; error: string } {
  if (value === undefined || value === null) return { ok: true };
  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    scope,
    error: parseErrorMessage(parsed.error),
  };
}

export interface ResolveAgentExecutionConfigOptions {
  source: AgentTaskSource;
  group?: RegisteredGroup;
  taskOverride?: unknown;
  websocketOverride?: unknown;
}

export interface ResolveAgentExecutionConfigResult {
  ok: true;
  config: AgentExecutionConfig;
}

export interface ResolveAgentExecutionConfigError {
  ok: false;
  scope: AgentExecutionConfigScope;
  error: string;
}

const sourceDefaults: Record<AgentTaskSource, AgentExecutionConfig> = {
  chat: {},
  scheduled: {},
  websocket: { reasoningEffort: 'low' },
};

export function resolveAgentExecutionConfig(
  options: ResolveAgentExecutionConfigOptions,
): ResolveAgentExecutionConfigResult | ResolveAgentExecutionConfigError {
  const globalState = initializeGlobalAgentConfig();
  if (!globalState.valid) {
    return {
      ok: false,
      scope: 'global',
      error: globalState.error || 'Invalid global agent config',
    };
  }

  const groupLayer = parseScoped(
    agentExecutionSourceConfigSchema,
    options.group?.containerConfig?.agentConfig,
    'group',
  );
  if (!groupLayer.ok) return groupLayer;

  const websocketOverride = parseScoped(
    agentExecutionConfigSchema,
    options.websocketOverride,
    'websocket',
  );
  if (!websocketOverride.ok) return websocketOverride;

  const taskOverride = parseScoped(
    agentExecutionConfigSchema,
    options.taskOverride,
    'task',
  );
  if (!taskOverride.ok) return taskOverride;

  let resolved: AgentExecutionConfig = {};
  resolved = mergeConfig(resolved, readLegacyDefaults());
  resolved = applySourceLayer(resolved, options.source, globalState.config);
  resolved = mergeConfig(resolved, sourceDefaults[options.source]);
  resolved = applySourceLayer(resolved, options.source, groupLayer.value);
  resolved = mergeConfig(resolved, websocketOverride.value);
  resolved = mergeConfig(resolved, taskOverride.value);

  return { ok: true, config: resolved };
}
