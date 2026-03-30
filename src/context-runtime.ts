import { randomUUID } from 'crypto';

import {
  clearSession,
  getContextTurnsAfterId,
  getContextTurnsInRange,
  getLatestContextTurnId,
  getOrCreateGroupMemoryState,
  insertContextTurn,
  updateGroupMemoryState,
} from './db.js';
import { loadContextConfig } from './context-config.js';
import { buildContextBootstrapBundle } from './context-bootstrap.js';
import {
  computeSlidingWindowBoundary,
  shouldCompactContext,
} from './context-compaction.js';
import { estimateTokens } from './context-store.js';
import { logger } from './logger.js';
import { updateSummaryMemory } from './summary-memory.js';
import {
  AgentTaskSource,
  EventExecutionContextMode,
  RegisteredGroup,
  TurnUsage,
} from './types.js';
import { ContainerOutput } from './container-runner.js';
import { readSharedInstructionTextsForGroup } from './shared-instructions.js';

export interface ContextParticipation {
  enabled: boolean;
  config: ReturnType<typeof loadContextConfig>;
}

export function isContextSourceEnabled(params: {
  source: AgentTaskSource;
  contextMode?: EventExecutionContextMode;
}): ContextParticipation {
  const config = loadContextConfig();
  if (!config.enabled) {
    return { enabled: false, config };
  }

  const { source, contextMode } = params;
  const enabled =
    source === 'chat'
      ? config.sources.chat
      : contextMode === 'group'
        ? source === 'scheduled'
          ? config.sources.scheduledGroupContext
          : config.sources.websocketGroupContext
        : config.sources.isolatedTasks;

  return { enabled, config };
}

export function buildPromptWithBootstrap(params: {
  groupFolder: string;
  source: AgentTaskSource;
  prompt: string;
  sessionId?: string;
}): string {
  return getPromptWithBootstrapDetails(params).prompt;
}

export function getPromptWithBootstrapDetails(params: {
  groupFolder: string;
  source: AgentTaskSource;
  prompt: string;
  sessionId?: string;
}): {
  prompt: string;
  contextDebug: {
    bootstrapUsed: boolean;
    summaryIncluded: boolean;
    recentTurnsScope: 'shared' | 'source-only' | 'none';
    recentTurnCount: number;
  };
} {
  const memoryState = getOrCreateGroupMemoryState(params.groupFolder);
  if (params.sessionId && params.sessionId.trim()) {
    return {
      prompt: params.prompt,
      contextDebug: {
        bootstrapUsed: false,
        summaryIncluded: false,
        recentTurnsScope: 'none',
        recentTurnCount: 0,
      },
    };
  }

  const recentTurns = getContextTurnsAfterId(
    params.groupFolder,
    memoryState.last_compacted_turn_id,
  );
  const historyScope =
    params.source === 'chat' ? ('shared' as const) : ('source-only' as const);
  const scopedRecentTurns =
    historyScope === 'shared'
      ? recentTurns
      : recentTurns.filter((turn) => turn.source === params.source);
  const bundle = buildContextBootstrapBundle({
    summaryYaml: memoryState.summary_yaml,
    recentTurns: scopedRecentTurns,
    currentInput: params.prompt,
    currentSource: params.source,
    historyScope,
  });

  return {
    prompt: bundle.prompt,
    contextDebug: {
      bootstrapUsed: true,
      summaryIncluded: bundle.metadata.summaryIncluded,
      recentTurnsScope: bundle.metadata.historyScope,
      recentTurnCount: bundle.metadata.recentTurnCount,
    },
  };
}

export function buildLiveSessionKey(params: {
  groupFolder: string;
  source: AgentTaskSource;
  contextMode?: EventExecutionContextMode;
}): string | undefined {
  if (params.source === 'chat') {
    return `${params.groupFolder}::chat`;
  }

  if (params.contextMode !== 'group') {
    return undefined;
  }

  return `${params.groupFolder}::${params.source}`;
}

export function prepareContextSessionForTurn(params: {
  groupFolder: string;
  sessionKey: string;
  sessionId?: string;
  config: ReturnType<typeof loadContextConfig>;
  clearSessionCache: () => void;
}): string | undefined {
  const existingSessionId = params.sessionId?.trim();
  if (!existingSessionId) {
    return undefined;
  }

  if (!params.config.compaction.enabled) {
    return existingSessionId;
  }

  const memoryState = getOrCreateGroupMemoryState(params.groupFolder);
  const activeTurns = getContextTurnsAfterId(
    params.groupFolder,
    memoryState.last_compacted_turn_id,
  );
  const decision = shouldCompactContext({
    config: params.config.compaction,
    memoryState,
    activeTurns,
  });

  if (!decision.shouldCompact) {
    return existingSessionId;
  }

  const newBoundary = computeSlidingWindowBoundary({
    activeTurns,
    window: params.config.compaction.window,
  });

  if (newBoundary <= memoryState.last_compacted_turn_id) {
    return existingSessionId;
  }

  updateGroupMemoryState(params.groupFolder, {
    last_compacted_turn_id: newBoundary,
    last_compaction_at: new Date().toISOString(),
  });

  if (params.config.compaction.restartSessionAfterCompact) {
    clearSession(params.sessionKey);
    params.clearSessionCache();
    return undefined;
  }

  return existingSessionId;
}

export async function recordCompletedContextTurn(params: {
  group: RegisteredGroup;
  chatJid: string;
  source: AgentTaskSource;
  contextMode?: EventExecutionContextMode;
  sessionKey?: string;
  userPrompt: string;
  assistantResponse: string | null;
  usage?: TurnUsage;
  closeWorker: () => void;
  clearSessionCache: () => void;
  invokeInternalPrompt: (prompt: string) => Promise<ContainerOutput>;
}): Promise<void> {
  const participation = isContextSourceEnabled({
    source: params.source,
    contextMode: params.contextMode,
  });
  if (!participation.enabled) return;

  const { config } = participation;
  const now = new Date().toISOString();
  const batchId = randomUUID();

  insertContextTurn({
    group_folder: params.group.folder,
    chat_jid: params.chatJid,
    source: params.source,
    role: 'user',
    content: params.userPrompt,
    created_at: now,
    est_tokens: estimateTokens(params.userPrompt),
    actual_input_tokens: params.usage?.inputTokens ?? null,
    actual_output_tokens: null,
    batch_id: batchId,
    metadata_json: null,
  });

  if (params.assistantResponse) {
    insertContextTurn({
      group_folder: params.group.folder,
      chat_jid: params.chatJid,
      source: params.source,
      role: 'assistant',
      content: params.assistantResponse,
      created_at: new Date().toISOString(),
      est_tokens: estimateTokens(params.assistantResponse),
      actual_input_tokens: params.usage?.inputTokens ?? null,
      actual_output_tokens: params.usage?.outputTokens ?? null,
      batch_id: batchId,
      metadata_json: null,
    });
  }

  let memoryState = updateGroupMemoryState(params.group.folder, {
    last_input_tokens: params.usage?.inputTokens ?? null,
    last_output_tokens: params.usage?.outputTokens ?? null,
  });

  const latestTurnId = getLatestContextTurnId(params.group.folder);
  const unsummarizedTurns = latestTurnId - memoryState.last_summarized_turn_id;

  if (
    config.summaryMemory.enabled &&
    unsummarizedTurns >= config.summaryMemory.updateMinTurns
  ) {
    const deltaTurns = getContextTurnsInRange(
      params.group.folder,
      memoryState.last_summarized_turn_id,
      latestTurnId,
    );

    try {
      const summaryResult = await updateSummaryMemory({
        currentSummaryYaml: memoryState.summary_yaml,
        deltaTurns: deltaTurns.map((turn) => ({
          role: turn.role,
          source: turn.source,
          content: turn.content,
          createdAt: turn.created_at,
        })),
        sharedInstructionTexts: readSharedInstructionTextsForGroup(
          params.group,
          params.group.isMain === true,
        ),
        config: config.summaryMemory,
        invoke: async (prompt) => {
          const output = await params.invokeInternalPrompt(prompt);
          if (output.status === 'error') {
            throw new Error(output.error || 'summary update failed');
          }
          return output.result || '';
        },
      });

      memoryState = updateGroupMemoryState(params.group.folder, {
        summary_yaml: summaryResult.yaml,
        last_summarized_turn_id: latestTurnId,
        last_summary_at: new Date().toISOString(),
      });
    } catch (error) {
      logger.warn(
        { group: params.group.folder, error },
        'Summary memory update failed; preserving previous summary',
      );
    }
  }

  if (!config.compaction.enabled) {
    return;
  }

  const activeTurns = getContextTurnsAfterId(
    params.group.folder,
    memoryState.last_compacted_turn_id,
  );
  const decision = shouldCompactContext({
    config: config.compaction,
    memoryState,
    usage: params.usage,
    activeTurns,
  });

  if (!decision.shouldCompact) {
    return;
  }

  const newBoundary = computeSlidingWindowBoundary({
    activeTurns,
    window: config.compaction.window,
  });
  if (newBoundary <= memoryState.last_compacted_turn_id) {
    return;
  }

  updateGroupMemoryState(params.group.folder, {
    last_compacted_turn_id: newBoundary,
    last_compaction_at: new Date().toISOString(),
  });

  if (config.compaction.restartSessionAfterCompact) {
    if (params.sessionKey) {
      clearSession(params.sessionKey);
    }
    params.clearSessionCache();
    params.closeWorker();
  }
}
