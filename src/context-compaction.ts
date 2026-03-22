import {
  CompactionConfig,
  ContextTurn,
  GroupMemoryState,
  TurnUsage,
} from './types.js';

export interface CompactionDecision {
  shouldCompact: boolean;
  reason?: 'usage' | 'estimate';
  estimatedActiveTokens: number;
}

export function shouldCompactContext(params: {
  config: CompactionConfig;
  memoryState: GroupMemoryState;
  usage?: TurnUsage;
  activeTurns: ContextTurn[];
}): CompactionDecision {
  const estimatedActiveTokens = params.activeTurns.reduce(
    (sum, turn) => sum + turn.est_tokens,
    0,
  );
  const lastInputTokens =
    params.usage?.inputTokens ??
    params.memoryState.last_input_tokens ??
    undefined;

  if (
    lastInputTokens !== undefined &&
    lastInputTokens >= params.config.trigger.lastInputTokensGte
  ) {
    return { shouldCompact: true, reason: 'usage', estimatedActiveTokens };
  }

  if (
    estimatedActiveTokens >= params.config.trigger.fallbackEstimatedTokensGte
  ) {
    return { shouldCompact: true, reason: 'estimate', estimatedActiveTokens };
  }

  return { shouldCompact: false, estimatedActiveTokens };
}

export function computeSlidingWindowBoundary(params: {
  activeTurns: ContextTurn[];
  window: CompactionConfig['window'];
}): number {
  const { activeTurns, window } = params;
  if (activeTurns.length <= window.keepRecentTurns) {
    return 0;
  }

  let tokenTotal = 0;
  const kept: ContextTurn[] = [];
  for (let index = activeTurns.length - 1; index >= 0; index -= 1) {
    const turn = activeTurns[index];
    const nextTotal = tokenTotal + turn.est_tokens;
    const mustKeepForTurnCount = kept.length < window.keepRecentTurns;
    if (!mustKeepForTurnCount && nextTotal > window.keepRecentEstimatedTokens) {
      break;
    }
    kept.push(turn);
    tokenTotal = nextTotal;
  }

  if (kept.length === activeTurns.length) {
    return 0;
  }

  const earliestKept = kept[kept.length - 1];
  return Math.max(0, earliestKept.id - 1);
}
