import fs from 'fs';
import path from 'path';

import { z } from 'zod';

import {
  mergeAgentExecutionConfig,
  mergeAgentExecutionSourceConfig,
  resetGlobalAgentConfigCache,
  agentExecutionSourceConfigSchema,
} from './agent-config.js';
import {
  AGENT_CONFIG_PATH,
  CONTEXT_CONFIG_PATH,
  LOGS_DIR,
  WEBSOCKET_SOURCES_PATH,
} from './config.js';
import {
  parseContextConfig,
  getDefaultContextConfig,
  resetContextConfigCache,
} from './context-config.js';
import { getTaskById, setRegisteredGroup, updateTask } from './db.js';
import { logger } from './logger.js';
import { formatLocalIsoTimestamp } from './time.js';
import { agentExecutionConfigSchema } from './agent-config.js';
import type {
  AgentExecutionConfig,
  AgentExecutionSourceConfig,
  RegisteredGroup,
  ScheduledTask,
} from './types.js';

const reasoningEffortSchema = z.enum([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]);

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

const agentExecutionConfigPatchSchema = z
  .object({
    model: z.string().min(1).optional(),
    reasoningEffort: reasoningEffortSchema.optional(),
    codexConfigOverrides: z.record(z.string(), jsonValueSchema).optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.model !== undefined ||
      v.reasoningEffort !== undefined ||
      v.codexConfigOverrides !== undefined,
    {
      message:
        'Agent execution config patch must include model, reasoningEffort, or codexConfigOverrides',
    },
  );

const agentExecutionSourceConfigPatchSchema = z
  .object({
    defaults: agentExecutionConfigPatchSchema.optional(),
    bySource: z
      .object({
        chat: agentExecutionConfigPatchSchema.optional(),
        scheduled: agentExecutionConfigPatchSchema.optional(),
        websocket: agentExecutionConfigPatchSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((v) => v.defaults !== undefined || v.bySource !== undefined, {
    message: 'Agent config patch must include defaults or bySource',
  });

const contextConfigPatchSchema = z
  .object({
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
      .strict()
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
          .strict()
          .optional(),
        window: z
          .object({
            keepRecentTurns: z.number().int().min(1).optional(),
            keepRecentEstimatedTokens: z.number().int().min(1).optional(),
          })
          .partial()
          .strict()
          .optional(),
        restartSessionAfterCompact: z.boolean().optional(),
      })
      .partial()
      .strict()
      .optional(),
    sources: z
      .object({
        chat: z.boolean().optional(),
        scheduledGroupContext: z.boolean().optional(),
        websocketGroupContext: z.boolean().optional(),
        isolatedTasks: z.boolean().optional(),
      })
      .partial()
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.enabled !== undefined ||
      v.summaryMemory !== undefined ||
      v.compaction !== undefined ||
      v.sources !== undefined,
    {
      message: 'Context config patch must include at least one field',
    },
  );

const websocketSubscriptionPatchSchema = z
  .object({
    runTask: z.boolean().optional(),
    logTaskResult: z.boolean().optional(),
    taskInstructions: z.string().min(1).optional(),
    contextMode: z.enum(['group', 'isolated']).optional(),
    deliverOutput: z.boolean().optional(),
    cooldownMs: z.number().int().nonnegative().optional(),
    agentConfig: agentExecutionConfigPatchSchema.optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.runTask !== undefined ||
      v.logTaskResult !== undefined ||
      v.taskInstructions !== undefined ||
      v.contextMode !== undefined ||
      v.deliverOutput !== undefined ||
      v.cooldownMs !== undefined ||
      v.agentConfig !== undefined,
    {
      message:
        'WebSocket subscription patch must include at least one supported field',
    },
  );

const websocketRawRootSchema = z
  .object({
    connections: z.record(z.string(), z.unknown()).default({}),
    subscriptions: z.array(z.unknown()).default([]),
  })
  .passthrough();

const websocketSubscriptionBaseSchema = z
  .object({
    id: z.string().min(1),
    connection: z.string().min(1),
    kind: z.literal('events'),
    eventType: z.string().min(1),
    targetJid: z.string().min(1),
    promptTemplate: z.string().min(1),
  })
  .passthrough();

const configChangeLogPath = path.join(LOGS_DIR, 'config-changes.log');

export type ConfigMutationDomain = 'agent' | 'context' | 'websocket';
export type ConfigMutationScope = 'global' | 'group' | 'task' | 'subscription';

export interface ConfigMutationRequest {
  domain: ConfigMutationDomain;
  scope: ConfigMutationScope;
  target?: string;
  changes: unknown;
  unsetPaths?: string[];
  reason?: string;
  targetJid?: string;
  taskId?: string;
  subscriptionId?: string;
  actorGroup: string;
  isMain: boolean;
}

export interface ConfigMutationDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
  reloadWebSocketSources?: () => Promise<void>;
}

export interface ConfigMutationResult {
  ok: boolean;
  message: string;
  before?: unknown;
  after?: unknown;
  target?: string;
  reloadWebSockets?: boolean;
}

interface PreparedConfigMutation {
  target: string;
  before: unknown;
  after: unknown;
  reloadWebSockets: boolean;
  apply: () => Promise<void>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeRequestTarget(
  request: ConfigMutationRequest,
): ConfigMutationRequest {
  if (!request.target) return request;

  const [domainScope, identifier] = request.target.split(':', 2);
  const [domain, scope] = domainScope.split('/', 2);
  if (
    (domain !== 'agent' && domain !== 'context' && domain !== 'websocket') ||
    (scope !== 'global' &&
      scope !== 'group' &&
      scope !== 'task' &&
      scope !== 'subscription')
  ) {
    throw new Error(`Invalid target: ${request.target}`);
  }

  const normalized: ConfigMutationRequest = {
    ...request,
    domain,
    scope,
  };

  if (domain === 'agent' && scope === 'group') {
    normalized.targetJid = identifier;
  } else if (domain === 'agent' && scope === 'task') {
    normalized.taskId = identifier;
  } else if (domain === 'websocket' && scope === 'subscription') {
    normalized.subscriptionId = identifier;
  }

  return normalized;
}

function applyUnsetPaths<T>(value: T, unsetPaths?: string[]): T {
  if (!unsetPaths || unsetPaths.length === 0) return value;
  if (!isPlainObject(value)) {
    throw new Error('unsetPaths can only be applied to object values');
  }

  const clone = structuredClone(value) as Record<string, unknown>;
  for (const unsetPath of unsetPaths) {
    if (typeof unsetPath !== 'string' || !unsetPath.trim()) {
      throw new Error('unsetPaths entries must be non-empty strings');
    }
    const segments = unsetPath.split('.');
    if (segments.some((segment) => !segment || /^\d+$/.test(segment))) {
      throw new Error(
        `unsetPaths does not support array indices: ${unsetPath}`,
      );
    }

    let cursor: Record<string, unknown> | undefined = clone;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const next: unknown = cursor?.[segments[i]];
      if (!isPlainObject(next)) {
        cursor = undefined;
        break;
      }
      cursor = next;
    }
    if (!cursor) continue;
    delete cursor[segments[segments.length - 1]];
  }

  return clone as T;
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return patch === undefined ? base : (patch as T);
  }

  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = result[key];
    result[key] =
      isPlainObject(current) && isPlainObject(value)
        ? deepMerge(current, value)
        : value;
  }
  return result as T;
}

function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJsonFile(filePath: string): unknown | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function writeJsonFile(filePath: string, value: unknown): void {
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function appendConfigChangeLog(entry: Record<string, unknown>): void {
  ensureParentDir(configChangeLogPath);
  fs.appendFileSync(
    configChangeLogPath,
    `${JSON.stringify({ timestamp: formatLocalIsoTimestamp(), ...entry })}\n`,
  );
}

function formatTargetLabel(request: ConfigMutationRequest): string {
  if (request.domain === 'agent' && request.scope === 'global') {
    return 'agent/global';
  }
  if (request.domain === 'agent' && request.scope === 'group') {
    return `agent/group:${request.targetJid}`;
  }
  if (request.domain === 'agent' && request.scope === 'task') {
    return `agent/task:${request.taskId}`;
  }
  if (request.domain === 'context' && request.scope === 'global') {
    return 'context/global';
  }
  if (request.domain === 'websocket' && request.scope === 'subscription') {
    return `websocket/subscription:${request.subscriptionId}`;
  }
  return `${request.domain}/${request.scope}`;
}

function validateAgentPatch(
  request: ConfigMutationRequest,
): AgentExecutionConfig | AgentExecutionSourceConfig | null {
  if (request.domain !== 'agent') return null;

  if (request.scope === 'global' || request.scope === 'group') {
    const parsed = agentExecutionSourceConfigPatchSchema.safeParse(
      request.changes,
    );
    if (!parsed.success) {
      throw new Error(
        parsed.error.issues.map((issue) => issue.message).join('; '),
      );
    }
    return parsed.data;
  }

  const parsed = agentExecutionConfigPatchSchema.safeParse(request.changes);
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues.map((issue) => issue.message).join('; '),
    );
  }
  return parsed.data;
}

function validateContextPatch(
  request: ConfigMutationRequest,
): Record<string, unknown> {
  const parsed = contextConfigPatchSchema.safeParse(request.changes);
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues.map((issue) => issue.message).join('; '),
    );
  }
  return parsed.data;
}

function validateWebSocketPatch(
  request: ConfigMutationRequest,
): Record<string, unknown> {
  const parsed = websocketSubscriptionPatchSchema.safeParse(request.changes);
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues.map((issue) => issue.message).join('; '),
    );
  }
  return parsed.data;
}

function authorizeGlobal(request: ConfigMutationRequest): void {
  if (!request.isMain) {
    throw new Error('Only the main group can modify global configuration');
  }
}

function validateAgentConfig(value: unknown): AgentExecutionConfig {
  const parsed = agentExecutionConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues.map((issue) => issue.message).join('; '),
    );
  }
  return parsed.data;
}

function validateAgentSourceConfig(value: unknown): AgentExecutionSourceConfig {
  const parsed = agentExecutionSourceConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues.map((issue) => issue.message).join('; '),
    );
  }
  return parsed.data;
}

function requireOwnedGroup(
  request: ConfigMutationRequest,
  registeredGroups: Record<string, RegisteredGroup>,
): RegisteredGroup {
  if (!request.targetJid) {
    throw new Error('targetJid is required for group config updates');
  }
  const group = registeredGroups[request.targetJid];
  if (!group) {
    throw new Error(`Unknown group JID: ${request.targetJid}`);
  }
  if (!request.isMain && group.folder !== request.actorGroup) {
    throw new Error('Unauthorized group config update');
  }
  return group;
}

function requireOwnedTask(request: ConfigMutationRequest): ScheduledTask {
  if (!request.taskId) {
    throw new Error('taskId is required for task config updates');
  }
  const task = getTaskById(request.taskId);
  if (!task) {
    throw new Error(`Unknown task: ${request.taskId}`);
  }
  if (!request.isMain && task.group_folder !== request.actorGroup) {
    throw new Error('Unauthorized task config update');
  }
  return task;
}

function requireWebSocketSubscription(
  request: ConfigMutationRequest,
  root: z.infer<typeof websocketRawRootSchema>,
): Record<string, unknown> {
  if (!request.subscriptionId) {
    throw new Error('subscriptionId is required for websocket updates');
  }

  const subscription = root.subscriptions.find((entry) => {
    if (!isPlainObject(entry)) return false;
    return entry.id === request.subscriptionId;
  });

  if (!subscription || !isPlainObject(subscription)) {
    throw new Error(
      `Unknown websocket subscription: ${request.subscriptionId}`,
    );
  }

  const parsed = websocketSubscriptionBaseSchema.safeParse(subscription);
  if (!parsed.success) {
    throw new Error(
      `Subscription ${request.subscriptionId} is invalid and cannot be updated`,
    );
  }

  return subscription;
}

function buildApplyFailure(
  request: ConfigMutationRequest,
  error: unknown,
): ConfigMutationResult {
  const message = error instanceof Error ? error.message : String(error);
  appendConfigChangeLog({
    actorGroup: request.actorGroup,
    isMain: request.isMain,
    domain: request.domain,
    scope: request.scope,
    target: formatTargetLabel(request),
    status: 'rejected',
    reason: request.reason || null,
    error: message,
  });
  logger.warn(
    {
      actorGroup: request.actorGroup,
      domain: request.domain,
      scope: request.scope,
      target: formatTargetLabel(request),
      error: message,
    },
    'Config update rejected',
  );
  return {
    ok: false,
    message,
    target: formatTargetLabel(request),
  };
}

async function prepareConfigMutation(
  request: ConfigMutationRequest,
  deps: ConfigMutationDeps,
): Promise<PreparedConfigMutation> {
  const normalizedRequest = normalizeRequestTarget(request);
  const target = formatTargetLabel(normalizedRequest);
  if (normalizedRequest.domain === 'agent') {
    const patch = validateAgentPatch(normalizedRequest);
    if (normalizedRequest.scope === 'global') {
      authorizeGlobal(normalizedRequest);
      const currentRaw = readJsonFile(AGENT_CONFIG_PATH);
      const current = currentRaw
        ? validateAgentSourceConfig(currentRaw)
        : undefined;
      const merged = applyUnsetPaths(
        mergeAgentExecutionSourceConfig(
          current,
          patch as AgentExecutionSourceConfig,
        ),
        normalizedRequest.unsetPaths,
      );
      const validated = validateAgentSourceConfig(merged);
      return {
        target,
        before: current || null,
        after: validated,
        reloadWebSockets: false,
        apply: async () => {
          writeJsonFile(AGENT_CONFIG_PATH, validated);
          resetGlobalAgentConfigCache();
        },
      };
    }

    if (normalizedRequest.scope === 'group') {
      const groups = deps.registeredGroups();
      const group = requireOwnedGroup(normalizedRequest, groups);
      const currentConfig = group.containerConfig?.agentConfig;
      const merged = applyUnsetPaths(
        mergeAgentExecutionSourceConfig(
          currentConfig,
          patch as AgentExecutionSourceConfig,
        ),
        normalizedRequest.unsetPaths,
      );
      const validated = validateAgentSourceConfig(merged);
      const nextGroup: RegisteredGroup = {
        ...group,
        containerConfig: {
          ...(group.containerConfig || {}),
          agentConfig: validated,
        },
      };
      return {
        target,
        before: currentConfig || null,
        after: validated,
        reloadWebSockets: false,
        apply: async () => {
          groups[normalizedRequest.targetJid!] = nextGroup;
          setRegisteredGroup(normalizedRequest.targetJid!, nextGroup);
        },
      };
    }

    if (normalizedRequest.scope === 'task') {
      const task = requireOwnedTask(normalizedRequest);
      const currentConfig = task.agent_config;
      const merged = applyUnsetPaths(
        mergeAgentExecutionConfig(
          currentConfig || {},
          patch as AgentExecutionConfig,
        ),
        normalizedRequest.unsetPaths,
      );
      const validated = validateAgentConfig(merged);
      return {
        target,
        before: currentConfig || null,
        after: validated,
        reloadWebSockets: false,
        apply: async () => {
          updateTask(normalizedRequest.taskId!, { agent_config: validated });
        },
      };
    }
  }

  if (normalizedRequest.domain === 'context') {
    if (normalizedRequest.scope !== 'global') {
      throw new Error('Context config updates only support the global scope');
    }
    authorizeGlobal(normalizedRequest);
    const patch = validateContextPatch(normalizedRequest);
    const currentRaw = readJsonFile(CONTEXT_CONFIG_PATH);
    const current = currentRaw
      ? parseContextConfig(currentRaw)
      : getDefaultContextConfig();
    const merged = applyUnsetPaths(
      deepMerge(current, patch),
      normalizedRequest.unsetPaths,
    );
    const validated = parseContextConfig(merged);
    return {
      target,
      before: current,
      after: validated,
      reloadWebSockets: false,
      apply: async () => {
        writeJsonFile(CONTEXT_CONFIG_PATH, validated);
        resetContextConfigCache();
      },
    };
  }

  if (normalizedRequest.domain === 'websocket') {
    if (normalizedRequest.scope !== 'subscription') {
      throw new Error(
        'WebSocket config updates only support subscription scope',
      );
    }
    authorizeGlobal(normalizedRequest);
    const patch = validateWebSocketPatch(normalizedRequest);
    const raw = readJsonFile(WEBSOCKET_SOURCES_PATH);
    if (!raw) {
      throw new Error('WebSocket source config file does not exist');
    }
    const root = websocketRawRootSchema.parse(raw);
    const subscription = requireWebSocketSubscription(normalizedRequest, root);
    const currentSubscription = { ...subscription };
    const mergedSubscription = applyUnsetPaths(
      deepMerge(currentSubscription, patch) as Record<string, unknown>,
      normalizedRequest.unsetPaths,
    );

    if (mergedSubscription.agentConfig !== undefined) {
      mergedSubscription.agentConfig = validateAgentConfig(
        mergedSubscription.agentConfig,
      );
    }

    const nextRoot = {
      ...root,
      subscriptions: root.subscriptions.map((entry) => {
        if (
          !isPlainObject(entry) ||
          entry.id !== normalizedRequest.subscriptionId
        ) {
          return entry;
        }
        return mergedSubscription;
      }),
    };

    return {
      target,
      before: currentSubscription,
      after: mergedSubscription,
      reloadWebSockets: true,
      apply: async () => {
        writeJsonFile(WEBSOCKET_SOURCES_PATH, nextRoot);
        if (deps.reloadWebSocketSources) {
          await deps.reloadWebSocketSources();
        }
      },
    };
  }

  throw new Error('Unsupported config update request');
}

export async function inspectConfigUpdate(
  request: ConfigMutationRequest,
  deps: ConfigMutationDeps,
): Promise<ConfigMutationResult> {
  try {
    const prepared = await prepareConfigMutation(request, deps);
    return {
      ok: true,
      message: `Preview ready for ${prepared.target}`,
      target: prepared.target,
      before: prepared.before,
      after: prepared.after,
      reloadWebSockets: prepared.reloadWebSockets,
    };
  } catch (error) {
    return buildApplyFailure(request, error);
  }
}

export async function applyConfigUpdate(
  request: ConfigMutationRequest,
  deps: ConfigMutationDeps,
): Promise<ConfigMutationResult> {
  try {
    const prepared = await prepareConfigMutation(request, deps);
    await prepared.apply();
    appendConfigChangeLog({
      actorGroup: request.actorGroup,
      isMain: request.isMain,
      domain: request.domain,
      scope: request.scope,
      target: prepared.target,
      status: 'applied',
      reason: request.reason || null,
      before: prepared.before,
      after: prepared.after,
    });
    return {
      ok: true,
      message: `Applied config update to ${prepared.target}`,
      target: prepared.target,
      before: prepared.before,
      after: prepared.after,
      reloadWebSockets: prepared.reloadWebSockets,
    };
  } catch (error) {
    return buildApplyFailure(request, error);
  }
}
