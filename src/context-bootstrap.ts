import { ContextTurn } from './types.js';

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function buildContextBootstrapPrompt(params: {
  summaryYaml: string;
  recentTurns: ContextTurn[];
  currentInput: string;
  currentSource: string;
}): string {
  const recentTurns = params.recentTurns
    .map(
      (turn) =>
        `    <turn role="${turn.role}" source="${turn.source}" at="${turn.created_at}">${escapeXml(turn.content)}</turn>`,
    )
    .join('\n');

  return [
    '<context_bundle>',
    '  <structured_summary format="yaml">',
    params.summaryYaml.trim(),
    '  </structured_summary>',
    '',
    '  <recent_turns>',
    recentTurns,
    '  </recent_turns>',
    '',
    `  <current_input source="${params.currentSource}">`,
    escapeXml(params.currentInput),
    '  </current_input>',
    '</context_bundle>',
  ]
    .filter(Boolean)
    .join('\n');
}
