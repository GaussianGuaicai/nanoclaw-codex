import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  formatLocalDate,
  formatLocalIsoTimestamp,
} from '../container/agent-runner/src/runtime/time.js';

describe('agent runner local time formatting', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('formats local ISO timestamps with an explicit offset', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-23T04:43:30.301Z'));

    expect(formatLocalIsoTimestamp()).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/,
    );
  });

  it('derives the archive date from the formatted local timestamp', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-23T04:43:30.301Z'));

    expect(formatLocalDate()).toBe(formatLocalIsoTimestamp().split('T')[0]);
  });
});
