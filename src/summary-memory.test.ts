import { describe, expect, it, vi } from 'vitest';

import {
  buildSummaryUpdatePrompt,
  cleanSummaryMemoryAgainstSharedInstructions,
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
    expect(prompt).toContain(
      'Only record a failure in recent_failures when the delta turns show a concrete, current failure',
    );
    expect(prompt).toContain(
      'If currentSummaryYaml contains stale failure notes that are no longer supported by the delta turns',
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

  it('removes shared-instruction duplicates and generic prompt rules', () => {
    const cleaned = cleanSummaryMemoryAgainstSharedInstructions({
      doc: parseSummaryMemoryYaml(
        [
          'session_state:',
          '  task: "Track preferences"',
          '  decisions:',
          '    - When the user arrives home, mention that the computer is usually already opened automatically, but do not trigger anything yourself.',
          '    - Return YAML only.',
          '    - Decide whether this run needs a user-facing reply.',
          '    - Keep the living room comfortable.',
          '  constraints:',
          '    - Do not use markdown fences.',
          '    - If the task completed successfully but nothing needs to be surfaced now, return only <internal>...</internal> content.',
          '  active_entities: []',
          '  open_questions: []',
          '  important_paths: []',
          '  recent_failures: []',
          '  user_preferences:',
          '    - Treat `Home-WiFi*` as home Wi-Fi.',
          '    - If the user should be informed, send a concise user-facing update suitable for the target channel.',
          '    - The user prefers terse status updates.',
        ].join('\n'),
        10,
      ),
      sharedInstructionTexts: [
        [
          '- Treat `Home-WiFi*` as home Wi-Fi.',
          '- When the user arrives home, mention that the computer is usually already opened automatically, but do not trigger anything yourself.',
        ].join('\n'),
      ],
      maxItemsPerList: 10,
    });

    expect(cleaned.session_state.decisions).toEqual([
      'Keep the living room comfortable.',
    ]);
    expect(cleaned.session_state.constraints).toEqual([]);
    expect(cleaned.session_state.user_preferences).toEqual([
      'The user prefers terse status updates.',
    ]);
  });

  it('cleans duplicates against shared instructions after update', async () => {
    const updated = await updateSummaryMemory({
      currentSummaryYaml: getDefaultSummaryYaml(),
      deltaTurns: [],
      sharedInstructionTexts: ['- Treat `Home-WiFi*` as home Wi-Fi.'],
      config: {
        enabled: true,
        model: 'gpt-5.4-mini',
        reasoningEffort: 'low',
        updateMinTurns: 2,
        maxItemsPerList: 4,
      },
      invoke: async () =>
        [
          'session_state:',
          '  task: "Track state"',
          '  decisions: []',
          '  constraints: []',
          '  active_entities: []',
          '  open_questions: []',
          '  important_paths: []',
          '  recent_failures: []',
          '  user_preferences:',
          '    - Treat `Home-WiFi*` as home Wi-Fi.',
          '    - Prefer short updates.',
        ].join('\n'),
    });

    expect(updated.yaml).not.toContain('Treat `Home-WiFi*` as home Wi-Fi.');
    expect(updated.yaml).toContain('Prefer short updates.');
  });

  it('filters summary list entries before applying the max-items limit', async () => {
    const updated = await updateSummaryMemory({
      currentSummaryYaml: getDefaultSummaryYaml(),
      deltaTurns: [],
      sharedInstructionTexts: ['- Keep services on the host when possible.'],
      config: {
        enabled: true,
        model: 'gpt-5.4-mini',
        reasoningEffort: 'low',
        updateMinTurns: 2,
        maxItemsPerList: 3,
      },
      invoke: async () =>
        [
          'session_state:',
          '  task: "Track state"',
          '  decisions:',
          '    - Keep services on the host when possible.',
          '    - Return YAML only.',
          '    - Preserve the SQLite-first verification flow.',
          '    - Keep Home Assistant filters restricted to device_tracker.* entities.',
          '    - Route deliverOutput replies back through the owning channel.',
          '  constraints: []',
          '  active_entities: []',
          '  open_questions: []',
          '  important_paths: []',
          '  recent_failures: []',
          '  user_preferences: []',
        ].join('\n'),
    });

    expect(updated.yaml).toContain(
      'Preserve the SQLite-first verification flow.',
    );
    expect(updated.yaml).toContain(
      'Keep Home Assistant filters restricted to device_tracker.* entities.',
    );
    expect(updated.yaml).toContain(
      'Route deliverOutput replies back through the owning channel.',
    );
    expect(updated.yaml).not.toContain(
      'Keep services on the host when possible.',
    );
    expect(updated.yaml).not.toContain('Return YAML only.');
  });
});
