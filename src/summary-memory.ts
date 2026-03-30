import YAML from 'yaml';
import { z } from 'zod';

import {
  SummaryMemoryConfig,
  SummaryMemoryDocument,
  SummaryMemoryState,
} from './types.js';

export const SUMMARY_SCHEMA_VERSION = 1;

const summaryStringArraySchema = z.array(z.string().default('')).default([]);

const summaryMemorySchema = z
  .object({
    session_state: z
      .object({
        task: z.string().default(''),
        decisions: summaryStringArraySchema,
        constraints: summaryStringArraySchema,
        active_entities: summaryStringArraySchema,
        open_questions: summaryStringArraySchema,
        important_paths: summaryStringArraySchema,
        recent_failures: summaryStringArraySchema,
        user_preferences: summaryStringArraySchema,
      })
      .strict(),
  })
  .strict();

type SummaryListKey = Exclude<keyof SummaryMemoryState, 'task'>;

const summaryListKeys: SummaryListKey[] = [
  'decisions',
  'constraints',
  'active_entities',
  'open_questions',
  'important_paths',
  'recent_failures',
  'user_preferences',
];

export function createEmptySummaryMemory(): SummaryMemoryDocument {
  return {
    session_state: {
      task: '',
      decisions: [],
      constraints: [],
      active_entities: [],
      open_questions: [],
      important_paths: [],
      recent_failures: [],
      user_preferences: [],
    },
  };
}

export function stripYamlFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:yaml|yml)?\s*([\s\S]*?)```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

export function normalizeSummaryMemory(
  input: SummaryMemoryDocument,
  maxItemsPerList: number,
): SummaryMemoryDocument {
  const normalized = summaryMemorySchema.parse(input) as SummaryMemoryDocument;
  normalized.session_state.task = normalized.session_state.task.trim();

  for (const key of summaryListKeys) {
    const deduped = Array.from(
      new Set(
        normalized.session_state[key]
          .map((item: string) => item.trim())
          .filter((item: string) => item.length > 0),
      ),
    );
    normalized.session_state[key] = deduped.slice(0, maxItemsPerList);
  }

  return normalized;
}

export function parseSummaryMemoryYaml(
  raw: string,
  maxItemsPerList: number,
): SummaryMemoryDocument {
  const cleaned = stripYamlFences(raw);
  const parsed = cleaned ? YAML.parse(cleaned) : createEmptySummaryMemory();
  return normalizeSummaryMemory(parsed, maxItemsPerList);
}

export function stringifySummaryMemoryYaml(doc: SummaryMemoryDocument): string {
  return YAML.stringify(doc, {
    defaultKeyType: 'PLAIN',
    defaultStringType: 'QUOTE_DOUBLE',
    lineWidth: 0,
  }).trim();
}

export function getDefaultSummaryYaml(): string {
  return stringifySummaryMemoryYaml(createEmptySummaryMemory());
}

function normalizeComparableText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[`*_#>]/g, ' ')
    .replace(/^\s*[-*+•]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractSharedInstructionCandidates(
  sharedInstructionTexts: string[],
): Set<string> {
  const candidates = new Set<string>();

  for (const text of sharedInstructionTexts) {
    const normalizedWhole = normalizeComparableText(text);
    if (normalizedWhole) {
      candidates.add(normalizedWhole);
    }

    for (const line of text.split('\n')) {
      const normalizedLine = normalizeComparableText(line);
      if (normalizedLine) {
        candidates.add(normalizedLine);
      }
    }
  }

  return candidates;
}

function isGenericPromptRule(item: string): boolean {
  const normalized = normalizeComparableText(item);
  if (!normalized) return true;

  return [
    'return yaml only.',
    'return yaml only',
    'do not use markdown fences.',
    'do not use markdown fences',
    'do not output explanations.',
    'do not output explanations',
    'channel reply requirements:',
    'decide whether this event needs a user-facing reply.',
    'if the user should be informed, send a concise user-facing reply suitable for the target channel.',
    'if no user-visible update is needed, return only <internal></internal> content.',
  ].some((value) => normalized === normalizeComparableText(value));
}

export function cleanSummaryMemoryAgainstSharedInstructions(params: {
  doc: SummaryMemoryDocument;
  sharedInstructionTexts: string[];
  maxItemsPerList: number;
}): SummaryMemoryDocument {
  const normalized = normalizeSummaryMemory(params.doc, params.maxItemsPerList);
  const instructionCandidates = extractSharedInstructionCandidates(
    params.sharedInstructionTexts,
  );
  const next = structuredClone(normalized) as SummaryMemoryDocument;

  for (const key of ['decisions', 'user_preferences', 'constraints'] as const) {
    next.session_state[key] = next.session_state[key].filter((item) => {
      const normalizedItem = normalizeComparableText(item);
      if (!normalizedItem) return false;
      if (isGenericPromptRule(item)) return false;
      return !instructionCandidates.has(normalizedItem);
    });
  }

  return normalizeSummaryMemory(next, params.maxItemsPerList);
}

export function buildSummaryUpdatePrompt(params: {
  currentSummaryYaml: string;
  deltaTurns: Array<{
    role: 'user' | 'assistant';
    source: string;
    content: string;
    createdAt: string;
  }>;
}): string {
  const deltaTurnsYaml = params.deltaTurns
    .map(
      (turn) =>
        `- role: ${turn.role}\n  source: ${turn.source}\n  at: ${turn.createdAt}\n  content: |\n${indentBlock(turn.content, 4)}`,
    )
    .join('\n');

  return [
    'You are updating a durable structured session memory for an AI coding assistant.',
    'Shared instruction files such as AGENTS.md, CLAUDE.md, and preferences.md are provided separately to the agent.',
    '',
    'Return YAML only.',
    'Do not use markdown fences.',
    'Do not output explanations.',
    '',
    'Use this exact schema:',
    '',
    getDefaultSummaryYaml(),
    '',
    'Rules:',
    '- This summary stores durable session state, not the instructions in this prompt.',
    '- Preserve concrete facts, file paths, entity IDs, URLs, config keys, commands, and decisions.',
    '- Do not copy formatting or meta-output rules from this prompt into the summary.',
    '- Do not restate long-lived policies or preferences that already live in shared instruction files such as AGENTS.md, CLAUDE.md, or preferences.md.',
    '- Use user_preferences only for preferences learned from conversation that are not already captured in shared instruction files.',
    '- decisions should contain only durable operating conclusions that remain useful across multiple future turns.',
    '- Do not put one-off event adjudications, temporary environment readings, or single-run outcomes into decisions.',
    '- Do not store long-lived preferences in decisions when shared instruction files already contain them.',
    '- Keep unresolved questions in open_questions.',
    '- Move resolved questions out of open_questions.',
    '- Keep recent_failures limited to recent real failures only.',
    '- Only record a failure in recent_failures when the delta turns show a concrete, current failure such as an HTTP auth error, connection error, tool failure, or explicit inability to use a required capability.',
    '- If currentSummaryYaml contains stale failure notes that are no longer supported by the delta turns, remove them instead of carrying them forward.',
    '- Keep arrays deduplicated and concise.',
    '- Never invent facts.',
    '- Never emit raw JSON.',
    '',
    'CURRENT_SUMMARY_YAML:',
    params.currentSummaryYaml.trim() || getDefaultSummaryYaml(),
    '',
    'DELTA_TURNS:',
    deltaTurnsYaml ||
      '- role: user\n  source: chat\n  at: unknown\n  content: |\n    ',
  ].join('\n');
}

export function buildSummaryRepairPrompt(params: {
  invalidOutput: string;
  validationError: string;
}): string {
  return [
    'Repair the following output into valid YAML using the exact schema below.',
    'Return YAML only.',
    '',
    getDefaultSummaryYaml(),
    '',
    'VALIDATION_ERROR:',
    params.validationError,
    '',
    'INVALID_OUTPUT:',
    params.invalidOutput.trim(),
  ].join('\n');
}

export async function updateSummaryMemory(params: {
  currentSummaryYaml: string;
  deltaTurns: Array<{
    role: 'user' | 'assistant';
    source: string;
    content: string;
    createdAt: string;
  }>;
  sharedInstructionTexts?: string[];
  config: SummaryMemoryConfig;
  invoke: (prompt: string) => Promise<string>;
}): Promise<{ yaml: string; repaired: boolean }> {
  const prompt = buildSummaryUpdatePrompt({
    currentSummaryYaml: params.currentSummaryYaml,
    deltaTurns: params.deltaTurns,
  });

  const output = await params.invoke(prompt);
  try {
    const doc = cleanSummaryMemoryAgainstSharedInstructions({
      doc: parseSummaryMemoryYaml(output, params.config.maxItemsPerList),
      sharedInstructionTexts: params.sharedInstructionTexts || [],
      maxItemsPerList: params.config.maxItemsPerList,
    });
    return {
      yaml: stringifySummaryMemoryYaml(doc),
      repaired: false,
    };
  } catch (error) {
    const validationError =
      error instanceof Error ? error.message : String(error);
    const repairOutput = await params.invoke(
      buildSummaryRepairPrompt({
        invalidOutput: output,
        validationError,
      }),
    );
    const repaired = cleanSummaryMemoryAgainstSharedInstructions({
      doc: parseSummaryMemoryYaml(repairOutput, params.config.maxItemsPerList),
      sharedInstructionTexts: params.sharedInstructionTexts || [],
      maxItemsPerList: params.config.maxItemsPerList,
    });
    return {
      yaml: stringifySummaryMemoryYaml(repaired),
      repaired: true,
    };
  }
}

function indentBlock(text: string, spaces: number): string {
  const prefix = ' '.repeat(spaces);
  const lines = text.split('\n');
  if (lines.length === 0) return prefix;
  return lines.map((line) => `${prefix}${line}`).join('\n');
}
