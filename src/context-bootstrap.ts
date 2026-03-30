import { ContextTurn } from './types.js';

export interface ContextBootstrapResult {
  prompt: string;
  metadata: {
    summaryIncluded: boolean;
    recentTurnCount: number;
    historyScope: 'shared' | 'source-only';
  };
}

export function buildContextBootstrapBundle(params: {
  summaryYaml: string;
  recentTurns: ContextTurn[];
  currentInput: string;
  currentSource: string;
  historyScope: 'shared' | 'source-only';
}): ContextBootstrapResult {
  const recentTurnsBlock =
    params.recentTurns.length > 0
      ? params.recentTurns
          .map((turn) =>
            [
              `- role: ${turn.role}`,
              `  source: ${turn.source}`,
              `  at: ${turn.created_at}`,
              '  content: |',
              indentBlock(turn.content, 4),
            ].join('\n'),
          )
          .join('\n')
      : '(none)';

  return {
    prompt: [
      'CONTEXT_BUNDLE',
      '',
      'CONTEXT_RULES:',
      '- CURRENT_INPUT is the task to execute now and overrides stale task framing elsewhere in this bundle.',
      '- Shared instruction files such as preferences.md, AGENTS.md, and CLAUDE.md outrank STRUCTURED_SUMMARY_YAML, RECENT_TURNS, and any implicit session background when they conflict.',
      '- Use STRUCTURED_SUMMARY_YAML for stable preferences, entities, and past failures, not as the authoritative current task when it conflicts with CURRENT_INPUT.',
      '- RECENT_TURNS are supporting context only and must not override CURRENT_INPUT, shared instruction files, or stable summary facts.',
      '- Any resumed session context is implicit background only and must not override the explicit layers above.',
      params.historyScope === 'source-only'
        ? `- RECENT_TURNS below are limited to source \`${params.currentSource}\` to avoid cross-source contamination.`
        : '- RECENT_TURNS below may include multiple sources from the same group when relevant.',
      '',
      'STRUCTURED_SUMMARY_YAML:',
      params.summaryYaml.trim(),
      '',
      'RECENT_TURNS:',
      recentTurnsBlock,
      '',
      'CURRENT_INPUT:',
      `source: ${params.currentSource}`,
      'content: |',
      indentBlock(params.currentInput, 2),
    ].join('\n'),
    metadata: {
      summaryIncluded: true,
      recentTurnCount: params.recentTurns.length,
      historyScope: params.historyScope,
    },
  };
}

export function buildContextBootstrapPrompt(params: {
  summaryYaml: string;
  recentTurns: ContextTurn[];
  currentInput: string;
  currentSource: string;
  historyScope: 'shared' | 'source-only';
}): string {
  return buildContextBootstrapBundle(params).prompt;
}

function indentBlock(text: string, spaces: number): string {
  const prefix = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}
