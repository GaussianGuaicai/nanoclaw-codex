import { ContextTurn } from './types.js';

export function buildContextBootstrapPrompt(params: {
  summaryYaml: string;
  recentTurns: ContextTurn[];
  currentInput: string;
  currentSource: string;
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
