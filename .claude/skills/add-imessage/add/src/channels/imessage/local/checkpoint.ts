import { getRouterState, setRouterState } from '../../../db.js';

export interface IMessageCheckpoint {
  lastRowId: number;
  updatedAt: string;
}

const CHECKPOINT_KEY = 'imessage.local-macos.checkpoint';

export function loadIMessageCheckpoint(): IMessageCheckpoint {
  const raw = getRouterState(CHECKPOINT_KEY);
  if (!raw) {
    return {
      lastRowId: 0,
      updatedAt: new Date(0).toISOString(),
    };
  }

  try {
    const parsed = JSON.parse(raw) as Partial<IMessageCheckpoint>;
    return {
      lastRowId: Math.max(0, parsed.lastRowId || 0),
      updatedAt: parsed.updatedAt || new Date(0).toISOString(),
    };
  } catch {
    return {
      lastRowId: 0,
      updatedAt: new Date(0).toISOString(),
    };
  }
}

export function saveIMessageCheckpoint(lastRowId: number): IMessageCheckpoint {
  const checkpoint: IMessageCheckpoint = {
    lastRowId: Math.max(0, lastRowId),
    updatedAt: new Date().toISOString(),
  };
  setRouterState(CHECKPOINT_KEY, JSON.stringify(checkpoint));
  return checkpoint;
}
