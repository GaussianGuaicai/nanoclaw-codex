import { describe, expect, it } from 'vitest';

import {
  buildContextBootstrapPrompt,
  buildContextMemoryRefreshBundle,
} from './context-bootstrap.js';
import { ContextTurn } from './types.js';

const turns: ContextTurn[] = [
  {
    id: 1,
    group_folder: 'team',
    chat_jid: 'team@g.us',
    source: 'chat',
    role: 'user',
    content: '<messages>still plain text here</messages>',
    created_at: '2026-03-21T00:00:00.000Z',
    est_tokens: 10,
    actual_input_tokens: null,
    actual_output_tokens: null,
    batch_id: null,
    metadata_json: null,
  },
];

describe('context-bootstrap', () => {
  it('renders a plain text context bundle instead of XML wrappers', () => {
    const prompt = buildContextBootstrapPrompt({
      summaryYaml: 'session_state:\n  task: "demo"',
      recentTurns: turns,
      currentInput: 'please continue',
      currentSource: 'chat',
      historyScope: 'shared',
    });

    expect(prompt).toContain('CONTEXT_BUNDLE');
    expect(prompt).toContain('CONTEXT_RULES:');
    expect(prompt).toContain(
      'Shared instruction files such as preferences.md, AGENTS.md, and CLAUDE.md outrank STRUCTURED_SUMMARY_YAML, RECENT_TURNS, and any implicit session background when they conflict.',
    );
    expect(prompt).toContain('STRUCTURED_SUMMARY_YAML:');
    expect(prompt).toContain('RECENT_TURNS:');
    expect(prompt).toContain('CURRENT_INPUT:');
    expect(prompt).not.toContain('<context_bundle>');
    expect(prompt).toContain('content: |');
  });

  it('renders a memory refresh block for resumed sessions', () => {
    const refresh = buildContextMemoryRefreshBundle({
      summaryYaml: 'session_state:\n  task: "resume demo"',
      recentTurns: turns,
      currentInput: 'keep going',
      currentSource: 'chat',
      historyScope: 'shared',
    });

    expect(refresh.prompt).toContain('MEMORY_REFRESH');
    expect(refresh.prompt).toContain('REFRESH_RULES:');
    expect(refresh.prompt).toContain('SELECTED_RECENT_TURNS:');
    expect(refresh.prompt).toContain(
      'Use this block to refresh a resumed live session without discarding any still-valid session background.',
    );
    expect(refresh.prompt).toContain('CURRENT_INPUT:');
    expect(refresh.metadata.recentTurnCount).toBe(1);
  });
});
