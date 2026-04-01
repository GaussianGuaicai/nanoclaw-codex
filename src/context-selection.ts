import { CompactionWindowConfig, ContextTurn } from './types.js';

const MAX_RECENT_TURNS = 8;
const MAX_RETRIEVED_TURNS = 4;
const MIN_QUERY_TERM_LENGTH = 3;
const STOP_WORDS = new Set([
  'about',
  'after',
  'again',
  'agent',
  'and',
  'assistant',
  'before',
  'chat',
  'from',
  'have',
  'into',
  'just',
  'need',
  'please',
  'scheduled',
  'should',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'this',
  'turn',
  'user',
  'with',
  'your',
  'websocket',
]);

interface ContextTurnBatch {
  turns: ContextTurn[];
  estTokens: number;
  maxId: number;
  text: string;
}

export function selectContextTurnsForPrompt(params: {
  turns: ContextTurn[];
  currentInput: string;
  window: CompactionWindowConfig;
}): ContextTurn[] {
  if (params.turns.length === 0) {
    return [];
  }

  const batches = groupTurnsIntoBatches(params.turns);
  const selectedIds = new Set<number>();
  const selectedBatches: ContextTurnBatch[] = [];
  let remainingTokenBudget = Math.max(1, params.window.keepRecentEstimatedTokens);
  let selectedTurnCount = 0;
  let retrievedTurnCount = 0;
  const recentTurnBudget = Math.max(
    1,
    Math.min(params.window.keepRecentTurns, MAX_RECENT_TURNS),
  );
  const queryTerms = extractQueryTerms(params.currentInput);

  for (let index = batches.length - 1; index >= 0; index -= 1) {
    const batch = batches[index];
    if (selectedTurnCount >= recentTurnBudget) {
      break;
    }
    if (
      !canSelectBatch({
        batch,
        remainingTokenBudget,
        hasSelection: selectedBatches.length > 0,
      })
    ) {
      continue;
    }

    selectedBatches.push(batch);
    markSelected(batch, selectedIds);
    remainingTokenBudget = Math.max(0, remainingTokenBudget - batch.estTokens);
    selectedTurnCount += batch.turns.length;
  }

  if (remainingTokenBudget > 0 && queryTerms.size > 0) {
    const rankedBatches = batches
      .filter((batch) => !selectedIds.has(batch.maxId))
      .map((batch) => ({
        batch,
        score: countOverlap(batch.text, queryTerms),
      }))
      .filter((candidate) => candidate.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score || right.batch.maxId - left.batch.maxId,
      );

    for (const candidate of rankedBatches) {
      if (retrievedTurnCount >= MAX_RETRIEVED_TURNS) {
        break;
      }
      if (
        !canSelectBatch({
          batch: candidate.batch,
          remainingTokenBudget,
          hasSelection: selectedBatches.length > 0,
        })
      ) {
        continue;
      }

      selectedBatches.push(candidate.batch);
      markSelected(candidate.batch, selectedIds);
      remainingTokenBudget = Math.max(
        0,
        remainingTokenBudget - candidate.batch.estTokens,
      );
      retrievedTurnCount += candidate.batch.turns.length;
    }
  }

  const orderedTurns = selectedBatches
    .flatMap((batch) => batch.turns)
    .sort((left, right) => left.id - right.id);

  if (orderedTurns.length > 0) {
    return orderedTurns;
  }

  return params.turns.slice(-1);
}

function groupTurnsIntoBatches(turns: ContextTurn[]): ContextTurnBatch[] {
  const orderedTurns = turns.slice().sort((left, right) => left.id - right.id);
  const batches: ContextTurnBatch[] = [];
  let current: ContextTurnBatch | null = null;

  for (const turn of orderedTurns) {
    const currentBatchId = current?.turns[0]?.batch_id ?? null;
    const turnBatchId = turn.batch_id ?? null;
    const canAppend =
      current &&
      turnBatchId &&
      currentBatchId === turnBatchId &&
      turn.id === current.maxId + 1;

    if (!canAppend) {
      current = {
        turns: [],
        estTokens: 0,
        maxId: turn.id,
        text: '',
      };
      batches.push(current);
    }

    if (!current) {
      continue;
    }

    const activeBatch = current;
    activeBatch.turns.push(turn);
    activeBatch.estTokens += turn.est_tokens;
    activeBatch.maxId = turn.id;
    activeBatch.text = `${activeBatch.text}\n${turn.content}`.trim();
  }

  return batches;
}

function canSelectBatch(params: {
  batch: ContextTurnBatch;
  remainingTokenBudget: number;
  hasSelection: boolean;
}): boolean {
  if (params.batch.estTokens <= params.remainingTokenBudget) {
    return true;
  }

  return !params.hasSelection;
}

function markSelected(batch: ContextTurnBatch, selectedIds: Set<number>): void {
  for (const turn of batch.turns) {
    selectedIds.add(turn.id);
  }
}

function extractQueryTerms(text: string): Set<string> {
  const matches =
    text.toLowerCase().match(/[\p{L}\p{N}_./-]+/gu)?.filter(Boolean) || [];
  const normalized = matches
    .map((term) => term.trim())
    .filter((term) => term.length >= MIN_QUERY_TERM_LENGTH)
    .filter((term) => !STOP_WORDS.has(term));
  return new Set(normalized);
}

function countOverlap(text: string, queryTerms: Set<string>): number {
  if (queryTerms.size === 0) {
    return 0;
  }

  const seen = new Set<string>();
  const terms =
    text.toLowerCase().match(/[\p{L}\p{N}_./-]+/gu)?.filter(Boolean) || [];
  for (const term of terms) {
    if (queryTerms.has(term)) {
      seen.add(term);
    }
  }

  return seen.size;
}
