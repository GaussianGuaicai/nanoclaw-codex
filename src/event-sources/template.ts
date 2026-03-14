import {
  WebSocketFilterRule,
  NormalizedWebSocketEvent,
  WebSocketMatchValue,
  WebSocketSubscriptionConfig,
} from '../types.js';

const CHANNEL_REPLY_CONTRACT = [
  'Channel reply requirements:',
  '- Send a concise user-facing reply suitable for the target channel.',
  '- If no action is needed, still explain briefly what changed and why no action was taken.',
  '- Do not return only <internal>...</internal> content.',
].join('\n');

function getValueAtPath(
  payload: Record<string, unknown>,
  path: string,
): unknown {
  const parts = path.split('.').filter(Boolean);
  let current: unknown = payload;

  for (const part of parts) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

function isMatchValue(value: unknown): value is WebSocketMatchValue {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

function equalsMatch(actual: unknown, expected: WebSocketMatchValue): boolean {
  return isMatchValue(actual) && Object.is(actual, expected);
}

function evaluateFilterRule(
  rule: WebSocketFilterRule,
  event: NormalizedWebSocketEvent,
): boolean {
  const actual = getValueAtPath(event.payload, rule.path);
  const expected =
    rule.valueFromPath !== undefined
      ? getValueAtPath(event.payload, rule.valueFromPath)
      : rule.value;

  switch (rule.op) {
    case 'eq':
      return (
        expected !== undefined &&
        isMatchValue(actual) &&
        isMatchValue(expected) &&
        Object.is(actual, expected)
      );
    case 'neq':
      return (
        expected !== undefined &&
        isMatchValue(actual) &&
        isMatchValue(expected) &&
        !Object.is(actual, expected)
      );
    case 'in':
      return (
        Array.isArray(expected) &&
        expected.some((candidate) => equalsMatch(actual, candidate))
      );
    case 'not_in':
      return (
        Array.isArray(expected) &&
        !expected.some((candidate) => equalsMatch(actual, candidate))
      );
    case 'starts_with':
      return typeof actual === 'string' && typeof expected === 'string'
        ? actual.startsWith(expected)
        : false;
    case 'not_starts_with':
      return typeof actual === 'string' && typeof expected === 'string'
        ? !actual.startsWith(expected)
        : false;
    case 'exists':
      return actual !== undefined;
    case 'not_exists':
      return actual === undefined;
    default:
      return false;
  }
}

export function matchesSubscription(
  subscription: WebSocketSubscriptionConfig,
  event: NormalizedWebSocketEvent,
): boolean {
  for (const rule of subscription.filters || []) {
    if (!evaluateFilterRule(rule, event)) {
      return false;
    }
  }

  const match = subscription.match;
  if (!match) return true;

  for (const [path, expected] of Object.entries(match)) {
    const actual = getValueAtPath(event.payload, path);
    if (Array.isArray(expected)) {
      if (!expected.some((candidate) => equalsMatch(actual, candidate))) {
        return false;
      }
      continue;
    }

    if (!equalsMatch(actual, expected)) {
      return false;
    }
  }

  return true;
}

export function renderPromptTemplate(
  template: string,
  event: NormalizedWebSocketEvent,
): string {
  const replacements: Record<string, string> = {
    connection_name: event.connectionName,
    subscription_id: event.subscriptionId,
    event_type: event.eventType,
    time_fired: event.occurredAt,
    event_json: JSON.stringify(event.payload, null, 2),
  };

  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (match, key) => {
    return Object.hasOwn(replacements, key) ? replacements[key] : match;
  });
}

export function buildWebSocketTaskPrompt(
  subscription: WebSocketSubscriptionConfig,
  event: NormalizedWebSocketEvent,
): string {
  const sections: string[] = [];

  if (subscription.taskInstructions?.trim()) {
    sections.push(renderPromptTemplate(subscription.taskInstructions.trim(), event));
  }

  if (subscription.deliverOutput === true) {
    sections.push(CHANNEL_REPLY_CONTRACT);
  }

  sections.push(renderPromptTemplate(subscription.promptTemplate, event));

  return sections.join('\n\n');
}
