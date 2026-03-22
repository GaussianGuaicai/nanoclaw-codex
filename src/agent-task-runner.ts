import { ChildProcess } from 'child_process';

import { ASSISTANT_NAME } from './config.js';
import { setSession, getAllTasks } from './db.js';
import { resolveAgentExecutionConfig } from './agent-config.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeTasksSnapshot,
} from './container-runner.js';
import { GroupQueue } from './group-queue.js';
import {
  AgentExecutionConfig,
  AgentTaskSource,
  EventExecutionContextMode,
  RegisteredGroup,
  ScheduledTask,
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
  const sessionId =
    request.contextMode === 'group' ? sessions[group.folder] : undefined;

  writeTaskSnapshot(group);

  let result: string | null = null;
  let error: string | null = null;

  const TASK_CLOSE_DELAY_MS = 10000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleClose = () => {
    if (closeTimer) return;
    closeTimer = setTimeout(() => {
      deps.queue.closeStdin(request.chatJid);
    }, TASK_CLOSE_DELAY_MS);
  };

  const handleOutput = async (output: ContainerOutput) => {
    if (request.contextMode === 'group' && output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.result) {
      result = output.result;
      if (request.deliverOutput && deps.sendMessage) {
        await deps.sendMessage(request.chatJid, output.result);
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
        prompt: request.prompt,
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

    if (request.contextMode === 'group' && output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      result = output.result;
    }
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    error = err instanceof Error ? err.message : String(err);
  }

  return {
    status: error ? 'error' : 'success',
    result,
    error,
  };
}
