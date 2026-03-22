import {
  getContextTurnsAfterId,
  getLatestContextTurnId,
  getOrCreateGroupMemoryState,
  listContextTurnsForGroup,
} from './db.js';
import { ContextTurn, GroupMemoryState } from './types.js';

export function estimateTokens(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return Math.max(1, Math.ceil(trimmed.length / 4));
}

export function getActiveContextTurns(groupFolder: string): {
  memoryState: GroupMemoryState;
  activeTurns: ContextTurn[];
  latestTurnId: number;
} {
  const memoryState = getOrCreateGroupMemoryState(groupFolder);
  const activeTurns = getContextTurnsAfterId(
    groupFolder,
    memoryState.last_compacted_turn_id,
  );
  const latestTurnId = getLatestContextTurnId(groupFolder);
  return {
    memoryState,
    activeTurns,
    latestTurnId,
  };
}

export function getRecentContextTurns(groupFolder: string): ContextTurn[] {
  const memoryState = getOrCreateGroupMemoryState(groupFolder);
  return getContextTurnsAfterId(
    groupFolder,
    memoryState.last_compacted_turn_id,
  );
}

export function listAllContextTurns(groupFolder: string): ContextTurn[] {
  return listContextTurnsForGroup(groupFolder);
}
