import { describe, expect, it } from 'vitest';

import {
  buildBackgroundActivityPrompt,
  extractBackgroundActivitySummary,
} from './background-activity.js';

describe('background activity helpers', () => {
  it('prefers visible text when present', () => {
    expect(
      extractBackgroundActivitySummary(
        '<internal>hidden</internal>Turned off bedroom AC.',
      ),
    ).toBe('Turned off bedroom AC.');
  });

  it('falls back to internal text when no visible text exists', () => {
    expect(
      extractBackgroundActivitySummary(
        '<internal>turned off bedroom AC and armed security</internal>',
      ),
    ).toBe('turned off bedroom AC and armed security');
  });

  it('formats a background prompt block for chat session injection', () => {
    expect(
      buildBackgroundActivityPrompt([
        { source: 'websocket', summary: 'Turned off bedroom AC.' },
        { source: 'scheduled', summary: 'Set heater target to 28C.' },
      ]),
    ).toContain('The following items are system-generated context updates');
  });
});
