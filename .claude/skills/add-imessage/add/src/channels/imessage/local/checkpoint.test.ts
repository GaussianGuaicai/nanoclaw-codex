import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = new Map<string, string>();

vi.mock('../../../db.js', () => ({
  getRouterState: vi.fn((key: string) => state.get(key)),
  setRouterState: vi.fn((key: string, value: string) => state.set(key, value)),
}));

import {
  loadIMessageCheckpoint,
  saveIMessageCheckpoint,
} from './checkpoint.js';

describe('iMessage checkpoint persistence', () => {
  beforeEach(() => {
    state.clear();
    vi.clearAllMocks();
  });

  it('defaults to an empty checkpoint', () => {
    expect(loadIMessageCheckpoint().lastRowId).toBe(0);
  });

  it('round-trips through router_state', () => {
    saveIMessageCheckpoint(123);
    expect(loadIMessageCheckpoint().lastRowId).toBe(123);
  });
});
