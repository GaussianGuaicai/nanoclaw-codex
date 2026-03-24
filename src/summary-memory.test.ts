import { describe, expect, it, vi } from 'vitest';

import {
  buildSummaryUpdatePrompt,
  getDefaultSummaryYaml,
  parseSummaryMemoryYaml,
  stripYamlFences,
  updateSummaryMemory,
} from './summary-memory.js';

const maxItems = 3;

describe('summary-memory', () => {
  it('parses, normalizes, deduplicates, and trims yaml', () => {
    const parsed = parseSummaryMemoryYaml(
      `session_state:\n  task: "  Build feature  "\n  decisions:\n    - first\n    - first\n    - second\n    - third\n    - fourth\n  constraints:\n    - keep tests\n  active_entities: []\n  open_questions: []\n  important_paths: []\n  recent_failures: []\n  user_preferences: []\n`,
      maxItems,
    );

    expect(parsed.session_state.task).toBe('Build feature');
    expect(parsed.session_state.decisions).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('strips yaml fences', () => {
    expect(stripYamlFences('```yaml\na: 1\n```')).toBe('a: 1');
  });

  it('builds update prompt with summary and delta turns', () => {
    const prompt = buildSummaryUpdatePrompt({
      currentSummaryYaml: getDefaultSummaryYaml(),
      deltaTurns: [
        {
          role: 'user',
          source: 'chat',
          content: 'hello',
          createdAt: '2026-03-20T00:00:00.000Z',
        },
      ],
    });

    expect(prompt).toContain('CURRENT_SUMMARY_YAML:');
    expect(prompt).toContain('DELTA_TURNS:');
    expect(prompt).toContain('role: user');
    expect(prompt).toContain(
      'Do not restate long-lived policies or preferences that already live in shared instruction files',
    );
    expect(prompt).toContain(
      'Do not copy formatting or meta-output rules from this prompt into the summary.',
    );
  });

  it('repairs invalid output using repair prompt fallback', async () => {
    let calls = 0;
    const updated = await updateSummaryMemory({
      currentSummaryYaml: getDefaultSummaryYaml(),
      deltaTurns: [],
      config: {
        enabled: true,
        model: 'gpt-5.4-mini',
        reasoningEffort: 'low',
        updateMinTurns: 2,
        maxItemsPerList: 4,
      },
      invoke: async () => {
        calls += 1;
        if (calls === 1) {
          return 'not: [valid';
        }
        return getDefaultSummaryYaml();
      },
    });

    expect(updated.repaired).toBe(true);
    expect(updated.yaml).toContain('session_state:');
  });

  it('does not trigger repair when the initial invoke itself fails', async () => {
    const invoke = vi
      .fn<(_: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error('network down'));

    await expect(
      updateSummaryMemory({
        currentSummaryYaml: getDefaultSummaryYaml(),
        deltaTurns: [],
        config: {
          enabled: true,
          model: 'gpt-5.4-mini',
          reasoningEffort: 'low',
          updateMinTurns: 2,
          maxItemsPerList: 4,
        },
        invoke,
      }),
    ).rejects.toThrow('network down');

    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
