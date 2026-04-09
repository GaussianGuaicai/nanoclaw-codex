import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { readEnvFileMock, tempRoot, paths } = vi.hoisted(() => {
  const tempRoot = `${process.env.TMPDIR || '/tmp'}/nanoclaw-config-mutations-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const configRoot = `${tempRoot}/home/.config/nanoclaw`;
  return {
    readEnvFileMock: vi.fn().mockReturnValue({}),
    tempRoot,
    paths: {
      agentConfigPath: `${configRoot}/agent-config.json`,
      contextConfigPath: `${configRoot}/context-config.json`,
    websocketSourcesPath: `${configRoot}/websocket-sources.json`,
    logsDir: `${tempRoot}/logs`,
    storeDir: `${tempRoot}/store`,
    dataDir: `${tempRoot}/data`,
    groupsDir: `${tempRoot}/groups`,
  },
  };
});

vi.mock('./env.js', () => ({
  readEnvFile: readEnvFileMock,
}));

vi.mock('./config.js', async () => {
  const actual =
    await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    ASSISTANT_NAME: 'Andy',
    AGENT_CONFIG_PATH: paths.agentConfigPath,
    CONTEXT_CONFIG_PATH: paths.contextConfigPath,
    WEBSOCKET_SOURCES_PATH: paths.websocketSourcesPath,
    LOGS_DIR: paths.logsDir,
    DATA_DIR: paths.dataDir,
    STORE_DIR: paths.storeDir,
    GROUPS_DIR: paths.groupsDir,
  };
});

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { applyConfigUpdate, inspectConfigUpdate } from './config-mutations.js';
import { resolveAgentExecutionConfig } from './agent-config.js';
import {
  _initTestDatabase,
  createTask,
  getTaskById,
  getRegisteredGroup,
  setRegisteredGroup,
} from './db.js';
import { RegisteredGroup } from './types.js';

const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'main',
  trigger: 'always',
  added_at: '2026-01-01T00:00:00.000Z',
  isMain: true,
};

const OTHER_GROUP: RegisteredGroup = {
  name: 'Other',
  folder: 'other-group',
  trigger: '@Andy',
  added_at: '2026-01-01T00:00:00.000Z',
};

const deps = {
  registeredGroups: () => registeredGroups,
  reloadWebSocketSources: vi.fn().mockResolvedValue(undefined),
};

let registeredGroups: Record<string, RegisteredGroup>;

function ensureParentDirs(): void {
  fs.mkdirSync(path.dirname(paths.agentConfigPath), { recursive: true });
  fs.mkdirSync(paths.logsDir, { recursive: true });
  fs.mkdirSync(paths.storeDir, { recursive: true });
  fs.mkdirSync(paths.dataDir, { recursive: true });
  fs.mkdirSync(paths.groupsDir, { recursive: true });
}

function writeJson(filePath: string, value: unknown): void {
  ensureParentDirs();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

describe('config mutations', () => {
  beforeEach(() => {
    _initTestDatabase();
    ensureParentDirs();
    readEnvFileMock.mockReturnValue({});
    deps.reloadWebSocketSources.mockClear();

    registeredGroups = {
      'main@g.us': MAIN_GROUP,
      'other@g.us': OTHER_GROUP,
    };

    setRegisteredGroup('main@g.us', MAIN_GROUP);
    setRegisteredGroup('other@g.us', OTHER_GROUP);
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('applies a global agent config update and refreshes the cached resolver', async () => {
    writeJson(paths.agentConfigPath, {
      defaults: {
        reasoningEffort: 'low',
      },
    });

    const result = await applyConfigUpdate(
      {
        domain: 'agent',
        scope: 'global',
        changes: {
          defaults: {
            reasoningEffort: 'high',
            codexConfigOverrides: {
              global_flag: true,
            },
          },
        },
        reason: 'prefer the new chat model',
        actorGroup: 'main',
        isMain: true,
      },
      deps,
    );

    expect(result.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(paths.agentConfigPath, 'utf-8'))).toEqual(
      {
        defaults: {
          reasoningEffort: 'high',
          codexConfigOverrides: {
            global_flag: true,
          },
        },
      },
    );

    const resolved = resolveAgentExecutionConfig({ source: 'chat' });
    expect(resolved).toEqual({
      ok: true,
      config: {
        model: 'gpt-5.4-mini',
        reasoningEffort: 'high',
        codexConfigOverrides: {
          global_flag: true,
        },
      },
    });
  });

  it('applies a group agent config update only to the owning group', async () => {
    const result = await applyConfigUpdate(
      {
        domain: 'agent',
        scope: 'group',
        targetJid: 'other@g.us',
        changes: {
          defaults: {
            model: 'gpt-5.4-mini',
          },
        },
        reason: 'tune the group',
        actorGroup: 'other-group',
        isMain: false,
      },
      deps,
    );

    expect(result.ok).toBe(true);
    expect(registeredGroups['other@g.us'].containerConfig?.agentConfig).toEqual(
      {
        defaults: {
          model: 'gpt-5.4-mini',
        },
      },
    );
    expect(
      getRegisteredGroup('other@g.us')?.containerConfig?.agentConfig,
    ).toEqual({
      defaults: {
        model: 'gpt-5.4-mini',
      },
    });
  });

  it('returns a host-backed preview for context updates without writing anything', async () => {
    const result = await inspectConfigUpdate(
      {
        domain: 'context',
        scope: 'global',
        changes: {
          enabled: true,
          summaryMemory: {
            model: 'gpt-5.4-mini',
          },
        },
        reason: 'preview only',
        actorGroup: 'main',
        isMain: true,
      },
      deps,
    );

    expect(result).toMatchObject({
      ok: true,
      target: 'context/global',
    });
    expect(result.before).toMatchObject({
      enabled: false,
    });
    expect(result.after).toMatchObject({
      enabled: true,
      summaryMemory: {
        model: 'gpt-5.4-mini',
      },
    });
    expect(fs.existsSync(paths.contextConfigPath)).toBe(false);
  });

  it('updates a websocket subscription and reloads the manager', async () => {
    writeJson(paths.websocketSourcesPath, {
      connections: {
        ha_main: {
          provider: 'home_assistant',
          urlEnvVar: 'TEST_HA_URL',
          tokenEnvVar: 'TEST_HA_TOKEN',
        },
      },
      subscriptions: [
        {
          id: 'front-door',
          connection: 'ha_main',
          kind: 'events',
          eventType: 'state_changed',
          targetJid: 'main@g.us',
          promptTemplate: 'Handle {{event_type}}',
        },
      ],
    });

    const result = await applyConfigUpdate(
      {
        domain: 'websocket',
        scope: 'subscription',
        subscriptionId: 'front-door',
        changes: {
          cooldownMs: 5000,
          agentConfig: {
            reasoningEffort: 'medium',
          },
        },
        reason: 'reduce noise',
        actorGroup: 'main',
        isMain: true,
      },
      deps,
    );

    expect(result.ok).toBe(true);
    expect(deps.reloadWebSocketSources).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(fs.readFileSync(paths.websocketSourcesPath, 'utf-8')),
    ).toEqual({
      connections: {
        ha_main: {
          provider: 'home_assistant',
          urlEnvVar: 'TEST_HA_URL',
          tokenEnvVar: 'TEST_HA_TOKEN',
        },
      },
      subscriptions: [
        {
          id: 'front-door',
          connection: 'ha_main',
          kind: 'events',
          eventType: 'state_changed',
          targetJid: 'main@g.us',
          promptTemplate: 'Handle {{event_type}}',
          cooldownMs: 5000,
          agentConfig: {
            reasoningEffort: 'medium',
          },
        },
      ],
    });
  });

  it('rejects global context updates from non-main groups', async () => {
    const result = await applyConfigUpdate(
      {
        domain: 'context',
        scope: 'global',
        changes: {
          enabled: true,
        },
        reason: 'not allowed',
        actorGroup: 'other-group',
        isMain: false,
      },
      deps,
    );

    expect(result.ok).toBe(false);
    expect(fs.existsSync(paths.contextConfigPath)).toBe(false);
  });

  it('applies an agent task override to an existing task', async () => {
    createTask({
      id: 'task-1',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'existing task',
      schedule_type: 'once',
      schedule_value: '2026-04-01T09:00:00',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    const result = await applyConfigUpdate(
      {
        domain: 'agent',
        scope: 'task',
        taskId: 'task-1',
        changes: {
          model: 'gpt-5.4-mini',
          reasoningEffort: 'medium',
        },
        reason: 'task tuning',
        actorGroup: 'other-group',
        isMain: false,
      },
      deps,
    );

    expect(result.ok).toBe(true);
    expect(getTaskById('task-1')?.agent_config).toEqual({
      model: 'gpt-5.4-mini',
      reasoningEffort: 'medium',
    });
  });

  it('accepts the unified target field for websocket updates', async () => {
    writeJson(paths.websocketSourcesPath, {
      connections: {
        ha_main: {
          provider: 'home_assistant',
          urlEnvVar: 'TEST_HA_URL',
          tokenEnvVar: 'TEST_HA_TOKEN',
        },
      },
      subscriptions: [
        {
          id: 'front-door',
          connection: 'ha_main',
          kind: 'events',
          eventType: 'state_changed',
          targetJid: 'main@g.us',
          promptTemplate: 'Handle {{event_type}}',
        },
      ],
    });

    const result = await applyConfigUpdate(
      {
        target: 'websocket/subscription:front-door',
        domain: 'websocket',
        scope: 'subscription',
        changes: {
          deliverOutput: true,
        },
        reason: 'use unified target',
        actorGroup: 'main',
        isMain: true,
      },
      deps,
    );

    expect(result.ok).toBe(true);
    expect(
      JSON.parse(fs.readFileSync(paths.websocketSourcesPath, 'utf-8'))
        .subscriptions[0],
    ).toMatchObject({
      id: 'front-door',
      deliverOutput: true,
    });
  });

  it('supports unsetPaths during deep-merge updates', async () => {
    createTask({
      id: 'task-unset',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'existing task',
      schedule_type: 'once',
      schedule_value: '2026-04-01T09:00:00',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
      agent_config: {
        model: 'gpt-5.4-mini',
        reasoningEffort: 'high',
      },
    });

    const result = await applyConfigUpdate(
      {
        target: 'agent/task:task-unset',
        domain: 'agent',
        scope: 'task',
        changes: {
          model: 'gpt-5.4',
        },
        unsetPaths: ['reasoningEffort'],
        reason: 'remove reasoning override',
        actorGroup: 'other-group',
        isMain: false,
      },
      deps,
    );

    expect(result.ok).toBe(true);
    expect(getTaskById('task-unset')?.agent_config).toEqual({
      model: 'gpt-5.4',
    });
  });

  it('preserves colon characters in unified target identifiers', async () => {
    const slackGroup: RegisteredGroup = {
      name: 'Slack Main',
      folder: 'slack-main',
      trigger: '@Andy',
      added_at: '2026-01-01T00:00:00.000Z',
    };
    registeredGroups['slack:C123'] = slackGroup;
    setRegisteredGroup('slack:C123', slackGroup);

    const result = await applyConfigUpdate(
      {
        target: 'agent/group:slack:C123',
        domain: 'agent',
        scope: 'group',
        changes: {
          defaults: {
            model: 'gpt-5.4-mini',
          },
        },
        reason: 'support channel-prefixed ids',
        actorGroup: 'main',
        isMain: true,
      },
      deps,
    );

    expect(result.ok).toBe(true);
    expect(registeredGroups['slack:C123'].containerConfig?.agentConfig).toEqual({
      defaults: {
        model: 'gpt-5.4-mini',
      },
    });
  });

  it('rejects websocket updates that remove required subscription fields', async () => {
    writeJson(paths.websocketSourcesPath, {
      connections: {
        ha_main: {
          provider: 'home_assistant',
          urlEnvVar: 'TEST_HA_URL',
          tokenEnvVar: 'TEST_HA_TOKEN',
        },
      },
      subscriptions: [
        {
          id: 'front-door',
          connection: 'ha_main',
          kind: 'events',
          eventType: 'state_changed',
          targetJid: 'main@g.us',
          promptTemplate: 'Handle {{event_type}}',
        },
      ],
    });

    const result = await applyConfigUpdate(
      {
        domain: 'websocket',
        scope: 'subscription',
        subscriptionId: 'front-door',
        changes: {
          deliverOutput: true,
        },
        unsetPaths: ['promptTemplate'],
        reason: 'should fail validation',
        actorGroup: 'main',
        isMain: true,
      },
      deps,
    );

    expect(result.ok).toBe(false);
    expect(
      JSON.parse(fs.readFileSync(paths.websocketSourcesPath, 'utf-8'))
        .subscriptions[0],
    ).toMatchObject({
      id: 'front-door',
      promptTemplate: 'Handle {{event_type}}',
    });
  });

  it('redacts sensitive config values from the change log', async () => {
    const result = await applyConfigUpdate(
      {
        domain: 'agent',
        scope: 'global',
        changes: {
          defaults: {
            model: 'gpt-5.4-mini',
            codexConfigOverrides: {
              api_key: 'secret',
            },
          },
        },
        reason: 'verify redaction',
        actorGroup: 'main',
        isMain: true,
      },
      deps,
    );

    expect(result.ok).toBe(true);
    const changeLog = fs.readFileSync(
      path.join(paths.logsDir, 'config-changes.log'),
      'utf-8',
    );
    expect(changeLog).toContain('"codexConfigOverrides":"[REDACTED]"');
    expect(changeLog).not.toContain('secret');
  });

  it('updates a group-owned websocket subscription for a target group', async () => {
    writeJson(
      path.join(paths.groupsDir, 'other-group', 'config', 'websocket-sources.json'),
      {
        subscriptions: [
          {
            id: 'group-front-door',
            connection: 'ha_main',
            eventType: 'state_changed',
            promptTemplate: 'Handle {{event_type}}',
            deliverOutput: false,
          },
        ],
      },
    );

    const result = await applyConfigUpdate(
      {
        domain: 'websocket',
        scope: 'subscription',
        targetJid: 'other@g.us',
        subscriptionId: 'group-front-door',
        changes: {
          deliverOutput: true,
          cooldownMs: 3000,
        },
        reason: 'promote group-owned path',
        actorGroup: 'main',
        isMain: true,
      },
      deps,
    );

    expect(result.ok).toBe(true);
    expect(result.target).toBe(
      'websocket/subscription:group-front-door@other@g.us',
    );
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(
            paths.groupsDir,
            'other-group',
            'config',
            'websocket-sources.json',
          ),
          'utf-8',
        ),
      ),
    ).toEqual({
      subscriptions: [
        {
          id: 'group-front-door',
          connection: 'ha_main',
          eventType: 'state_changed',
          promptTemplate: 'Handle {{event_type}}',
          deliverOutput: true,
          cooldownMs: 3000,
        },
      ],
    });
  });

  it('allows a non-main group to update its own group-owned websocket subscription', async () => {
    writeJson(
      path.join(paths.groupsDir, 'other-group', 'config', 'websocket-sources.json'),
      {
        subscriptions: [
          {
            id: 'group-self',
            connection: 'ha_main',
            eventType: 'state_changed',
            promptTemplate: 'Self handler',
          },
        ],
      },
    );

    const result = await applyConfigUpdate(
      {
        domain: 'websocket',
        scope: 'subscription',
        targetJid: 'other@g.us',
        subscriptionId: 'group-self',
        changes: {
          logTaskResult: true,
        },
        reason: 'self update',
        actorGroup: 'other-group',
        isMain: false,
      },
      deps,
    );

    expect(result.ok).toBe(true);
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(
            paths.groupsDir,
            'other-group',
            'config',
            'websocket-sources.json',
          ),
          'utf-8',
        ),
      ).subscriptions[0],
    ).toMatchObject({
      id: 'group-self',
      logTaskResult: true,
    });
  });

  it('rejects non-main updates to another groups group-owned websocket subscription', async () => {
    writeJson(
      path.join(paths.groupsDir, 'other-group', 'config', 'websocket-sources.json'),
      {
        subscriptions: [
          {
            id: 'group-locked',
            connection: 'ha_main',
            eventType: 'state_changed',
            promptTemplate: 'Locked handler',
          },
        ],
      },
    );

    const result = await applyConfigUpdate(
      {
        domain: 'websocket',
        scope: 'subscription',
        targetJid: 'other@g.us',
        subscriptionId: 'group-locked',
        changes: {
          deliverOutput: true,
        },
        reason: 'unauthorized update',
        actorGroup: 'main',
        isMain: false,
      },
      deps,
    );

    expect(result.ok).toBe(false);
  });
});
