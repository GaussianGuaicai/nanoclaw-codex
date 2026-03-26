import { ContextTurn } from './types.js';

export function buildContextBootstrapPrompt(params: {
  summaryYaml: string;
  recentTurns: ContextTurn[];
  currentInput: string;
  currentSource: string;
  historyScope: 'shared' | 'source-only';
}): string {
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

  return [
    'CONTEXT_BUNDLE',
    '',
    'CONTEXT_RULES:',
    '- CURRENT_INPUT is the task to execute now and overrides stale task framing elsewhere in this bundle.',
    '- Use STRUCTURED_SUMMARY_YAML for stable preferences, entities, and past failures, not as the authoritative current task when it conflicts with CURRENT_INPUT.',
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
  ].join('\n');
}

function indentBlock(text: string, spaces: number): string {
  const prefix = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}
