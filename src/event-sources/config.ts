import fs from 'fs';
import os from 'os';
import path from 'path';

import { z } from 'zod';

import { agentExecutionConfigSchema } from '../agent-config.js';
import { WEBSOCKET_SOURCES_PATH } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import {
  WebSocketConnectionConfig,
  WebSocketSourcesConfig,
  WebSocketSubscriptionConfig,
} from '../types.js';

const matchValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

const connectionSchema = z.object({
  provider: z.string().min(1),
  urlEnvVar: z.string().min(1),
  tokenEnvVar: z.string().min(1),
  heartbeatIntervalMs: z.number().int().positive().optional(),
  requestTimeoutMs: z.number().int().positive().optional(),
  reconnect: z
    .object({
      initialDelayMs: z.number().int().positive().optional(),
      maxDelayMs: z.number().int().positive().optional(),
    })
    .optional(),
  features: z
    .object({
      coalesceMessages: z.boolean().optional(),
    })
    .optional(),
});

const filterRuleSchema = z
  .object({
    path: z.string().min(1),
    op: z.enum([
      'eq',
      'neq',
      'in',
      'not_in',
      'starts_with',
      'not_starts_with',
      'exists',
      'not_exists',
    ]),
    value: z.union([matchValueSchema, z.array(matchValueSchema)]).optional(),
    valueFromPath: z.string().min(1).optional(),
  })
  .superRefine((rule, ctx) => {
    const needsScalarOrPath =
      rule.op === 'eq' ||
      rule.op === 'neq' ||
      rule.op === 'starts_with' ||
      rule.op === 'not_starts_with';
    const needsArrayValue = rule.op === 'in' || rule.op === 'not_in';

    if (needsScalarOrPath && rule.value === undefined && !rule.valueFromPath) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Filter op "${rule.op}" requires value or valueFromPath`,
      });
    }

    if (needsArrayValue && !Array.isArray(rule.value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Filter op "${rule.op}" requires an array value`,
      });
    }

    if (
      (rule.op === 'starts_with' || rule.op === 'not_starts_with') &&
      rule.value !== undefined &&
      typeof rule.value !== 'string'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Filter op "${rule.op}" requires a string value`,
      });
    }
  });

const subscriptionSchema = z.object({
  id: z.string().min(1),
  connection: z.string().min(1),
  kind: z.literal('events'),
  eventType: z.string().min(1),
  filters: z.array(filterRuleSchema).optional(),
  match: z
    .record(z.string(), z.union([matchValueSchema, z.array(matchValueSchema)]))
    .optional(),
  logFilteredEvents: z.boolean().optional(),
  logCooldownEvents: z.boolean().optional(),
  runTask: z.boolean().optional(),
  logTaskResult: z.boolean().optional(),
  taskInstructions: z.string().min(1).optional(),
  taskInstructionsPath: z.string().min(1).optional(),
  targetJid: z.string().min(1),
  promptTemplate: z.string().min(1),
  contextMode: z.enum(['group', 'isolated']).optional(),
  deliverOutput: z.boolean().optional(),
  cooldownMs: z.number().int().nonnegative().optional(),
  agentConfig: agentExecutionConfigSchema.optional(),
});

export interface ResolvedWebSocketConnectionConfig extends WebSocketConnectionConfig {
  name: string;
  url: string;
  token: string;
}

export interface LoadedWebSocketSourcesConfig {
  connections: Record<string, ResolvedWebSocketConnectionConfig>;
  subscriptions: WebSocketSubscriptionConfig[];
}

function resolveUserPath(inputPath: string): string {
  if (inputPath.startsWith('~/')) {
    return path.join(process.env.HOME || os.homedir(), inputPath.slice(2));
  }

  return path.resolve(inputPath);
}

export function loadWebSocketSourcesConfig(): LoadedWebSocketSourcesConfig {
  let raw: unknown = { connections: {}, subscriptions: [] };

  if (!fs.existsSync(WEBSOCKET_SOURCES_PATH)) {
    logger.info(
      { path: WEBSOCKET_SOURCES_PATH },
      'WebSocket source config not found, skipping',
    );
    return { connections: {}, subscriptions: [] };
  }

  try {
    raw = JSON.parse(fs.readFileSync(WEBSOCKET_SOURCES_PATH, 'utf-8'));
  } catch (err) {
    logger.error(
      { err, path: WEBSOCKET_SOURCES_PATH },
      'Invalid WS source config',
    );
    return { connections: {}, subscriptions: [] };
  }

  const root = z
    .object({
      connections: z.record(z.string(), z.unknown()).default({}),
      subscriptions: z.array(z.unknown()).default([]),
    })
    .safeParse(raw);
  if (!root.success) {
    logger.error(
      { path: WEBSOCKET_SOURCES_PATH, issues: root.error.issues },
      'Invalid WS source config root',
    );
    return { connections: {}, subscriptions: [] };
  }

  const parsedConnections: WebSocketSourcesConfig['connections'] = {};
  for (const [name, value] of Object.entries(root.data.connections)) {
    const parsedConnection = connectionSchema.safeParse(value);
    if (!parsedConnection.success) {
      logger.error(
        {
          connection: name,
          issues: parsedConnection.error.issues,
        },
        'Skipping invalid WS connection',
      );
      continue;
    }
    parsedConnections[name] = parsedConnection.data;
  }

  const parsedSubscriptions: WebSocketSourcesConfig['subscriptions'] = [];
  for (const value of root.data.subscriptions) {
    const parsedSubscription = subscriptionSchema.safeParse(value);
    if (!parsedSubscription.success) {
      logger.error(
        {
          issues: parsedSubscription.error.issues,
        },
        'Skipping invalid WS subscription',
      );
      continue;
    }
    parsedSubscriptions.push(parsedSubscription.data);
  }

  const envKeys = Array.from(
    new Set(
      Object.values(parsedConnections).flatMap((connection) => [
        connection.urlEnvVar,
        connection.tokenEnvVar,
      ]),
    ),
  );

  const envFromFile = readEnvFile(envKeys);
  const connections: Record<string, ResolvedWebSocketConnectionConfig> = {};
  const subscriptions = parsedSubscriptions.map((subscription) => {
    if (!subscription.taskInstructionsPath) {
      return subscription;
    }

    const instructionsPath = resolveUserPath(subscription.taskInstructionsPath);

    try {
      const taskInstructions = fs
        .readFileSync(instructionsPath, 'utf-8')
        .trim();
      if (!taskInstructions) {
        logger.warn(
          {
            subscriptionId: subscription.id,
            path: instructionsPath,
          },
          'Ignoring empty WS task instructions file',
        );
        return subscription;
      }

      return {
        ...subscription,
        taskInstructions: subscription.taskInstructions
          ? `${subscription.taskInstructions.trim()}\n\n${taskInstructions}`
          : taskInstructions,
      };
    } catch (err) {
      logger.error(
        {
          err,
          subscriptionId: subscription.id,
          path: instructionsPath,
        },
        'Failed to load WS task instructions file',
      );
      return subscription;
    }
  });

  for (const [name, connection] of Object.entries(parsedConnections)) {
    const url =
      process.env[connection.urlEnvVar] || envFromFile[connection.urlEnvVar];
    const token =
      process.env[connection.tokenEnvVar] ||
      envFromFile[connection.tokenEnvVar];

    if (!url || !token) {
      logger.error(
        {
          connection: name,
          urlEnvVar: connection.urlEnvVar,
          tokenEnvVar: connection.tokenEnvVar,
        },
        'Skipping WS connection with missing env values',
      );
      continue;
    }

    connections[name] = {
      ...connection,
      name,
      url,
      token,
    };
  }

  return {
    connections,
    subscriptions,
  };
}
