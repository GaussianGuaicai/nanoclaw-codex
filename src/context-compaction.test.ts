import { describe, expect, it } from 'vitest';

import {
  computeSlidingWindowBoundary,
  shouldCompactContext,
} from './context-compaction.js';
import { GroupMemoryState, ContextTurn } from './types.js';

const state: GroupMemoryState = {
  group_folder: 'team',
  schema_version: 1,
  summary_yaml: 'session_state: {}',
  last_summarized_turn_id: 0,
  last_compacted_turn_id: 0,
  last_compaction_at: null,
  last_summary_at: null,
  last_input_tokens: null,
  last_output_tokens: null,
};

const turns: ContextTurn[] = [1, 2, 3, 4, 5].map((id) => ({
  id,
  group_folder: 'team',
  chat_jid: 'team@g.us',
  source: 'chat',
  role: id % 2 === 0 ? 'assistant' : 'user',
  content: `turn ${id}`,
  created_at: `2026-03-20T00:00:0${id}.000Z`,
  est_tokens: 100,
  actual_input_tokens: null,
  actual_output_tokens: null,
  batch_id: null,
  metadata_json: null,
}));

describe('context-compaction', () => {
  it('triggers compaction from real usage', () => {
    const decision = shouldCompactContext({
      config: {
        enabled: true,
        strategy: 'sliding-window',
        trigger: {
          lastInputTokensGte: 400,
          fallbackEstimatedTokensGte: 1000,
        },
        window: {
          keepRecentTurns: 2,
          keepRecentEstimatedTokens: 250,
        },
        restartSessionAfterCompact: true,
      },
      memoryState: state,
      usage: { inputTokens: 500 },
      activeTurns: turns,
    });

    expect(decision.shouldCompact).toBe(true);
    expect(decision.reason).toBe('usage');
  });

  it('computes a sliding boundary while keeping minimum recent turns', () => {
    const boundary = computeSlidingWindowBoundary({
      activeTurns: turns,
      window: {
        keepRecentTurns: 2,
        keepRecentEstimatedTokens: 250,
      },
    });

    expect(boundary).toBe(3);
  });
});
