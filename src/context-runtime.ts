import { randomUUID } from 'crypto';

import {
  clearSession,
  getContextTurnsAfterId,
  getContextTurnsInRange,
  getLatestContextTurnId,
  getOrCreateGroupMemoryState,
  insertContextMemoryEvent,
  insertContextTurn,
  updateGroupMemoryState,
} from './db.js';
import { loadContextConfig } from './context-config.js';
import {
  buildContextBootstrapBundle,
  buildContextMemoryRefreshBundle,
} from './context-bootstrap.js';
import {
  computeSlidingWindowBoundary,
  shouldCompactContext,
} from './context-compaction.js';
import { selectContextTurnsForPrompt } from './context-selection.js';
import { estimateTokens } from './context-store.js';
import { logger } from './logger.js';
import { updateSummaryMemory } from './summary-memory.js';
import {
  AgentTaskSource,
  EventExecutionContextMode,
  GroupMemoryState,
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
  config?: ReturnType<typeof loadContextConfig>;
}): string {
  return getPromptWithBootstrapDetails(params).prompt;
}

export function getPromptWithBootstrapDetails(params: {
  groupFolder: string;
  source: AgentTaskSource;
  prompt: string;
  sessionId?: string;
  config?: ReturnType<typeof loadContextConfig>;
}): {
  prompt: string;
  contextDebug: {
    bootstrapUsed: boolean;
    memoryRefreshUsed: boolean;
    summaryIncluded: boolean;
    recentTurnsScope: 'shared' | 'source-only' | 'none';
    recentTurnCount: number;
  };
} {
  const memoryState = getOrCreateGroupMemoryState(params.groupFolder);
  const config = params.config ?? loadContextConfig();
  const historyScope =
    params.source === 'chat' ? ('shared' as const) : ('source-only' as const);

  if (params.sessionId && params.sessionId.trim()) {
    const unsummarizedTurns = getContextTurnsAfterId(
      params.groupFolder,
      Math.max(
        memoryState.last_compacted_turn_id,
        memoryState.last_summarized_turn_id,
      ),
    );
    const scopedUnsummarizedTurns =
      historyScope === 'shared'
        ? unsummarizedTurns
        : unsummarizedTurns.filter((turn) => turn.source === params.source);
    const selectedRefreshTurns = selectContextTurnsForPrompt({
      turns: scopedUnsummarizedTurns,
      currentInput: params.prompt,
      window: config.compaction.window,
    });
    const refresh = buildContextMemoryRefreshBundle({
      summaryYaml: memoryState.summary_yaml,
      recentTurns: selectedRefreshTurns,
      currentInput: params.prompt,
      currentSource: params.source,
      historyScope,
    });

    return {
      prompt: refresh.prompt,
      contextDebug: {
        bootstrapUsed: false,
        memoryRefreshUsed: true,
        summaryIncluded: refresh.metadata.summaryIncluded,
        recentTurnsScope: refresh.metadata.historyScope,
        recentTurnCount: refresh.metadata.recentTurnCount,
      },
    };
  }

  const recentTurns = getContextTurnsAfterId(
    params.groupFolder,
    memoryState.last_compacted_turn_id,
  );
  const scopedRecentTurns =
    historyScope === 'shared'
      ? recentTurns
      : recentTurns.filter((turn) => turn.source === params.source);
  const selectedRecentTurns = selectContextTurnsForPrompt({
    turns: scopedRecentTurns,
    currentInput: params.prompt,
    window: config.compaction.window,
  });
  const bundle = buildContextBootstrapBundle({
    summaryYaml: memoryState.summary_yaml,
    recentTurns: selectedRecentTurns,
    currentInput: params.prompt,
    currentSource: params.source,
    historyScope,
  });

  return {
    prompt: bundle.prompt,
    contextDebug: {
      bootstrapUsed: true,
      memoryRefreshUsed: false,
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

interface MemoryStateSnapshot {
  summaryYaml: string;
  lastSummarizedTurnId: number;
  lastCompactedTurnId: number;
  lastSummaryAt: string | null;
  lastCompactionAt: string | null;
}

function snapshotMemoryState(
  memoryState: GroupMemoryState,
): MemoryStateSnapshot {
  return {
    summaryYaml: memoryState.summary_yaml,
    lastSummarizedTurnId: memoryState.last_summarized_turn_id,
    lastCompactedTurnId: memoryState.last_compacted_turn_id,
    lastSummaryAt: memoryState.last_summary_at ?? null,
    lastCompactionAt: memoryState.last_compaction_at ?? null,
  };
}

function createEmptyMemoryAuditPayload(params: {
  source: AgentTaskSource;
  contextMode?: EventExecutionContextMode;
  sessionKey?: string;
  memoryState: GroupMemoryState;
  compactionEnabled: boolean;
  restartSessionAfterCompact: boolean;
}): {
  version: 1;
  source: AgentTaskSource;
  contextMode?: EventExecutionContextMode;
  sessionKey?: string;
  summary: {
    attempted: boolean;
    succeeded: boolean;
    repaired: boolean;
    deltaTurnCount: number;
    deltaTurnIds: number[];
    before: MemoryStateSnapshot;
    after: MemoryStateSnapshot | null;
    error: string | null;
  };
  compaction: {
    enabled: boolean;
    attempted: boolean;
    shouldCompact: boolean;
    reason: 'usage' | 'estimate' | null;
    estimatedActiveTokens: number;
    boundaryBefore: number;
    boundaryAfter: number;
    restartSessionAfterCompact: boolean;
    sessionRestarted: boolean;
  };
} {
  return {
    version: 1,
    source: params.source,
    ...(params.contextMode ? { contextMode: params.contextMode } : {}),
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    summary: {
      attempted: false,
      succeeded: false,
      repaired: false,
      deltaTurnCount: 0,
      deltaTurnIds: [],
      before: snapshotMemoryState(params.memoryState),
      after: null,
      error: null,
    },
    compaction: {
      enabled: params.compactionEnabled,
      attempted: false,
      shouldCompact: false,
      reason: null,
      estimatedActiveTokens: 0,
      boundaryBefore: params.memoryState.last_compacted_turn_id,
      boundaryAfter: params.memoryState.last_compacted_turn_id,
      restartSessionAfterCompact: params.restartSessionAfterCompact,
      sessionRestarted: false,
    },
  };
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
  let memoryState = updateGroupMemoryState(params.group.folder, {
    last_input_tokens: params.usage?.inputTokens ?? null,
    last_output_tokens: params.usage?.outputTokens ?? null,
  });
  const audit = createEmptyMemoryAuditPayload({
    source: params.source,
    contextMode: params.contextMode,
    sessionKey: params.sessionKey,
    memoryState,
    compactionEnabled: config.compaction.enabled,
    restartSessionAfterCompact: config.compaction.restartSessionAfterCompact,
  });

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
    audit.summary.attempted = true;
    audit.summary.deltaTurnCount = deltaTurns.length;
    audit.summary.deltaTurnIds = deltaTurns.map((turn) => turn.id);

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
      audit.summary.succeeded = true;
      audit.summary.repaired = summaryResult.repaired;
      audit.summary.after = snapshotMemoryState(memoryState);
    } catch (error) {
      audit.summary.error =
        error instanceof Error ? error.message : String(error);
      logger.warn(
        { group: params.group.folder, error },
        'Summary memory update failed; preserving previous summary',
      );
    }
  }

  if (!config.compaction.enabled) {
    if (audit.summary.attempted) {
      insertContextMemoryEvent({
        group_folder: params.group.folder,
        event_type: 'summary-memory-maintenance',
        created_at: now,
        payload: audit,
      });
    }
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
  audit.compaction.shouldCompact = decision.shouldCompact;
  audit.compaction.reason = decision.reason ?? null;
  audit.compaction.estimatedActiveTokens = decision.estimatedActiveTokens;

  if (!decision.shouldCompact) {
    if (audit.summary.attempted) {
      insertContextMemoryEvent({
        group_folder: params.group.folder,
        event_type: 'summary-memory-maintenance',
        created_at: now,
        payload: audit,
      });
    }
    return;
  }

  const newBoundary = computeSlidingWindowBoundary({
    activeTurns,
    window: config.compaction.window,
  });
  audit.compaction.attempted = true;
  audit.compaction.boundaryAfter = newBoundary;
  if (newBoundary <= memoryState.last_compacted_turn_id) {
    insertContextMemoryEvent({
      group_folder: params.group.folder,
      event_type: 'summary-memory-maintenance',
      created_at: now,
      payload: audit,
    });
    return;
  }

  memoryState = updateGroupMemoryState(params.group.folder, {
    last_compacted_turn_id: newBoundary,
    last_compaction_at: new Date().toISOString(),
  });

  if (config.compaction.restartSessionAfterCompact) {
    if (params.sessionKey) {
      clearSession(params.sessionKey);
    }
    params.clearSessionCache();
    params.closeWorker();
    audit.compaction.sessionRestarted = true;
  }

  if (audit.summary.attempted || audit.compaction.attempted) {
    insertContextMemoryEvent({
      group_folder: params.group.folder,
      event_type: 'summary-memory-maintenance',
      created_at: now,
      payload: audit,
    });
  }
}
