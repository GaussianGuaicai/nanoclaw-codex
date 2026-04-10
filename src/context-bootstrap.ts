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
  return buildContextBundle({
    heading: 'CONTEXT_BUNDLE',
    rulesHeading: 'CONTEXT_RULES:',
    summaryYaml: params.summaryYaml,
    recentTurns: params.recentTurns,
    currentInput: params.currentInput,
    currentSource: params.currentSource,
    historyScope: params.historyScope,
    recentTurnsLabel: 'RECENT_TURNS:',
    resumeRule:
      '- Any resumed session context is implicit background only and must not override the explicit layers above.',
    recentTurnsRule:
      '- RECENT_TURNS are supporting context only and must not override CURRENT_INPUT, shared instruction files, or stable summary facts.',
    scopeRule:
      params.historyScope === 'source-only'
        ? `- RECENT_TURNS below are limited to source \`${params.currentSource}\` to avoid cross-source contamination.`
        : '- RECENT_TURNS below may include multiple sources from the same group when relevant.',
  });
}

export function buildContextMemoryRefreshBundle(params: {
  summaryYaml: string;
  recentTurns: ContextTurn[];
  currentInput: string;
  currentSource: string;
  historyScope: 'shared' | 'source-only';
}): ContextBootstrapResult {
  return buildContextBundle({
    heading: 'MEMORY_REFRESH',
    rulesHeading: 'REFRESH_RULES:',
    summaryYaml: params.summaryYaml,
    recentTurns: params.recentTurns,
    currentInput: params.currentInput,
    currentSource: params.currentSource,
    historyScope: params.historyScope,
    recentTurnsLabel: 'SELECTED_RECENT_TURNS:',
    resumeRule:
      '- Use this block to refresh a resumed live session without discarding any still-valid session background.',
    recentTurnsRule:
      '- SELECTED_RECENT_TURNS are a budgeted recall set, not the full history, and must not override CURRENT_INPUT or shared instruction files.',
    scopeRule:
      params.historyScope === 'source-only'
        ? `- SELECTED_RECENT_TURNS below are limited to source \`${params.currentSource}\` to avoid cross-source contamination.`
        : '- SELECTED_RECENT_TURNS below may include multiple sources from the same group when relevant.',
  });
}

function buildContextBundle(params: {
  heading: 'CONTEXT_BUNDLE' | 'MEMORY_REFRESH';
  rulesHeading: 'CONTEXT_RULES:' | 'REFRESH_RULES:';
  summaryYaml: string;
  recentTurns: ContextTurn[];
  currentInput: string;
  currentSource: string;
  historyScope: 'shared' | 'source-only';
  recentTurnsLabel: 'RECENT_TURNS:' | 'SELECTED_RECENT_TURNS:';
  resumeRule: string;
  recentTurnsRule: string;
  scopeRule: string;
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
      params.heading,
      '',
      params.rulesHeading,
      '- CURRENT_INPUT is the task to execute now and overrides stale task framing elsewhere in this bundle.',
      '- Shared instruction files such as preferences.md, AGENTS.md, and CLAUDE.md outrank STRUCTURED_SUMMARY_YAML, RECENT_TURNS, and any implicit session background when they conflict.',
      '- Use STRUCTURED_SUMMARY_YAML for stable preferences, entities, and past failures, not as the authoritative current task when it conflicts with CURRENT_INPUT.',
      params.recentTurnsRule,
      params.resumeRule,
      params.scopeRule,
      '',
      'STRUCTURED_SUMMARY_YAML:',
      params.summaryYaml.trim(),
      '',
      params.recentTurnsLabel,
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
