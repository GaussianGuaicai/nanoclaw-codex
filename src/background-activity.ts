import { formatOutbound } from './router.js';

const INTERNAL_BLOCK_RE = /<internal>([\s\S]*?)<\/internal>/gi;
const MAX_SUMMARY_LENGTH = 500;

export interface BackgroundActivityItem {
  source: 'websocket' | 'scheduled';
  summary: string;
}

export function extractBackgroundActivitySummary(
  rawText: string | null | undefined,
): string | null {
  if (!rawText) return null;

  const visible = normalizeSummary(formatOutbound(rawText));
  if (visible) return visible;

  const internalMatches = Array.from(rawText.matchAll(INTERNAL_BLOCK_RE))
    .map((match) => normalizeSummary(match[1] || ''))
    .filter((text): text is string => Boolean(text));

  return internalMatches[0] || null;
}

export function buildBackgroundActivityPrompt(
  items: BackgroundActivityItem[],
): string {
  const lines = items.map(
    (item) => `- [${item.source}] ${normalizeSummary(item.summary)}`,
  );

  return [
    '[BACKGROUND ACTIVITY]',
    'The following items are system-generated context updates, not user messages.',
    'Incorporate them into the live session context.',
    'Do not send a user-facing reply to these updates by themselves.',
    '',
    ...lines,
  ].join('\n');
}

function normalizeSummary(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';
  if (collapsed.length <= MAX_SUMMARY_LENGTH) return collapsed;
  return `${collapsed.slice(0, MAX_SUMMARY_LENGTH - 1)}…`;
}
