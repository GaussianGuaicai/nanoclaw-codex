import { ChildProcess } from 'child_process';

import { ASSISTANT_NAME } from './config.js';
import { setSession, getAllTasks } from './db.js';
import { resolveAgentExecutionConfig } from './agent-config.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  buildLiveSessionKey,
  getPromptWithBootstrapDetails,
  isContextSourceEnabled,
  prepareContextSessionForTurn,
  recordCompletedContextTurn,
} from './context-runtime.js';
import { formatVisibleOutbound } from './router.js';
import { GroupQueue } from './group-queue.js';
import { loadWorkerAgentConfig } from './worker-config.js';
import {
  AgentExecutionConfig,
  AgentTaskSource,
  EventExecutionContextMode,
  RegisteredGroup,
  ScheduledTask,
  TurnUsage,
} from './types.js';

export interface AgentTaskRunnerDeps {
  getSessions: () => Record<string, string>;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    executionName: string,
    groupFolder: string,
  ) => void;
  queue: GroupQueue;
  sendMessage?: (jid: string, text: string) => Promise<void>;
}

export interface AgentTaskRequest {
  chatJid: string;
  prompt: string;
  contextMode: EventExecutionContextMode;
  source: AgentTaskSource;
  agentConfigOverride?: AgentExecutionConfig;
  deliverOutput?: boolean;
  logWorkerInputOutput?: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
}

export interface AgentTaskResult {
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
  usage?: TurnUsage;
}

const SCHEDULED_AUTO_REPLY_CONTRACT = [
  'Channel reply requirements:',
  '- Decide whether this run needs a user-facing reply.',
  '- If the user should be informed, send a concise user-facing update suitable for the target channel.',
  '- If the task completed successfully but nothing needs to be surfaced now, return only <internal>...</internal> content.',
].join('\n');

function buildTaskPrompt(request: AgentTaskRequest): string {
  if (request.source === 'scheduled' && request.deliverOutput) {
    return `${SCHEDULED_AUTO_REPLY_CONTRACT}\n\n${request.prompt}`;
  }

  return request.prompt;
}

function writeTaskSnapshot(group: RegisteredGroup): void {
  const isMain = group.isMain === true;
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((task: ScheduledTask) => ({
      id: task.id,
      groupFolder: task.group_folder,
      prompt: task.prompt,
      schedule_type: task.schedule_type,
      schedule_value: task.schedule_value,
      status: task.status,
      next_run: task.next_run,
    })),
  );
}

export async function runSingleTurnAgentTask(
  group: RegisteredGroup,
  request: AgentTaskRequest,
  deps: AgentTaskRunnerDeps,
): Promise<AgentTaskResult> {
  const resolvedAgentConfig = resolveAgentExecutionConfig({
    source: request.source,
    group,
    workerConfig: loadWorkerAgentConfig(group.folder),
    taskOverride: request.agentConfigOverride,
  });
  if (!resolvedAgentConfig.ok) {
    const message = `Agent config error (${resolvedAgentConfig.scope}): ${resolvedAgentConfig.error}`;
    return {
      status: 'error',
      result: null,
      error: message,
    };
  }

  const isMain = group.isMain === true;
  const sessions = deps.getSessions();
  const contextParticipation = isContextSourceEnabled({
    source: request.source,
    contextMode: request.contextMode,
    groupFolder: group.folder,
  });
  const sessionKey = buildLiveSessionKey({
    groupFolder: group.folder,
    source: request.source,
    contextMode: request.contextMode,
  });
  const existingSessionId = sessionKey ? sessions[sessionKey] : undefined;
  const sessionId = contextParticipation.enabled
    ? sessionKey
      ? prepareContextSessionForTurn({
          groupFolder: group.folder,
          sessionKey,
          sessionId: existingSessionId,
          config: contextParticipation.config,
          clearSessionCache: () => {
            delete sessions[sessionKey];
          },
        })
      : undefined
    : existingSessionId;
  const promptWithContext = contextParticipation.enabled
    ? getPromptWithBootstrapDetails({
        groupFolder: group.folder,
        source: request.source,
        prompt: buildTaskPrompt(request),
        sessionId,
        config: contextParticipation.config,
      })
    : {
        prompt: buildTaskPrompt(request),
        contextDebug: {
          bootstrapUsed: false,
          memoryRefreshUsed: false,
          summaryIncluded: false,
          recentTurnsScope: 'none' as const,
          recentTurnCount: 0,
        },
      };

  writeTaskSnapshot(group);

  let result: string | null = null;
  let error: string | null = null;
  let usage: TurnUsage | undefined;

  const TASK_CLOSE_DELAY_MS = 10000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleClose = () => {
    if (closeTimer) return;
    closeTimer = setTimeout(() => {
      deps.queue.closeStdin(request.chatJid);
    }, TASK_CLOSE_DELAY_MS);
  };

  const handleOutput = async (output: ContainerOutput) => {
    if (output.usage) {
      usage = output.usage;
    }
    if (sessionKey && output.newSessionId) {
      sessions[sessionKey] = output.newSessionId;
      setSession(sessionKey, output.newSessionId);
    }

    if (output.result) {
      const visibleResult = formatVisibleOutbound(output.result);
      result = visibleResult || result;
      if (request.deliverOutput && deps.sendMessage && visibleResult) {
        await deps.sendMessage(request.chatJid, visibleResult);
      }
      scheduleClose();
    }

    if (output.status === 'success') {
      deps.queue.notifyIdle(request.chatJid);
    }

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    }
  };

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt: promptWithContext.prompt,
        contextDebug: promptWithContext.contextDebug,
        sessionId,
        groupFolder: group.folder,
        chatJid: request.chatJid,
        taskSource: request.source,
        isMain,
        agentConfig: resolvedAgentConfig.config,
        isScheduledTask: request.isScheduledTask,
        assistantName: request.assistantName || ASSISTANT_NAME,
        workerLogDetail:
          request.logWorkerInputOutput === true
            ? {
                includePrompt: true,
                includeResult: true,
              }
            : undefined,
      },
      (proc, executionName) =>
        deps.onProcess(request.chatJid, proc, executionName, group.folder),
      handleOutput,
    );

    if (closeTimer) clearTimeout(closeTimer);

    if (sessionKey && output.newSessionId) {
      sessions[sessionKey] = output.newSessionId;
      setSession(sessionKey, output.newSessionId);
    }

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      result = output.result;
    }
    if (output.usage) {
      usage = output.usage;
    }
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    error = err instanceof Error ? err.message : String(err);
  }

  if (!error && contextParticipation.enabled && result) {
    await recordCompletedContextTurn({
      group,
      chatJid: request.chatJid,
      source: request.source,
      contextMode: request.contextMode,
      sessionKey,
      userPrompt: request.prompt,
      assistantResponse: result,
      usage,
      closeWorker: () => deps.queue.closeStdin(request.chatJid),
      clearSessionCache: () => {
        if (sessionKey) {
          delete sessions[sessionKey];
        }
      },
      invokeInternalPrompt: async (internalPrompt) =>
        runContainerAgent(
          group,
          {
            prompt: internalPrompt,
            groupFolder: group.folder,
            chatJid: request.chatJid,
            taskSource: request.source,
            isMain,
            maintenancePurpose: 'summary-memory',
            suppressConversationArchive: true,
            agentConfig: {
              model: contextParticipation.config.summaryMemory.model,
              reasoningEffort:
                contextParticipation.config.summaryMemory.reasoningEffort,
            },
          },
          (proc, executionName) =>
            deps.onProcess(request.chatJid, proc, executionName, group.folder),
        ),
    });
  }

  return {
    status: error ? 'error' : 'success',
    result,
    error,
    usage,
  };
}
