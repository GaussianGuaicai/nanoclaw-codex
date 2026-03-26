import { describe, expect, it } from 'vitest';

import {
  buildWebSocketTaskPrompt,
  matchesSubscription,
  renderPromptTemplate,
} from './template.js';
import {
  NormalizedWebSocketEvent,
  WebSocketSubscriptionConfig,
} from '../types.js';

const subscription: WebSocketSubscriptionConfig = {
  id: 'door-open',
  connection: 'ha_main',
  kind: 'events',
  eventType: 'state_changed',
  match: {
    'data.entity_id': 'binary_sensor.front_door',
    'data.new_state.state': ['on', 'opening'],
  },
  targetJid: 'slack:C123',
  promptTemplate:
    'source={{connection_name}} sub={{subscription_id}} type={{event_type}} at={{time_fired}}\n{{event_json}}',
};

const event: NormalizedWebSocketEvent = {
  connectionName: 'ha_main',
  subscriptionId: 'door-open',
  provider: 'home_assistant',
  eventType: 'state_changed',
  occurredAt: '2026-03-12T10:00:00.000Z',
  payload: {
    event_type: 'state_changed',
    time_fired: '2026-03-12T10:00:00.000Z',
    data: {
      entity_id: 'binary_sensor.front_door',
      new_state: { state: 'on' },
    },
  },
};

describe('event source template helpers', () => {
  it('matches subscription filters using dot-paths and OR-arrays', () => {
    expect(matchesSubscription(subscription, event)).toBe(true);
  });

  it('returns false when a filter does not match', () => {
    expect(
      matchesSubscription(
        {
          ...subscription,
          match: { 'data.entity_id': 'light.kitchen' },
        },
        event,
      ),
    ).toBe(false);
  });

  it('supports generic path-to-path and prefix filter rules', () => {
    expect(
      matchesSubscription(
        {
          ...subscription,
          filters: [
            {
              path: 'data.old_state.state',
              op: 'neq',
              valueFromPath: 'data.new_state.state',
            },
            {
              path: 'data.entity_id',
              op: 'not_starts_with',
              value: 'button.',
            },
          ],
        },
        {
          ...event,
          payload: {
            event_type: 'state_changed',
            data: {
              entity_id: 'binary_sensor.front_door',
              old_state: { state: 'off' },
              new_state: { state: 'on' },
            },
          },
        },
      ),
    ).toBe(true);
  });

  it('returns false when a generic prefix filter matches', () => {
    expect(
      matchesSubscription(
        {
          ...subscription,
          filters: [
            {
              path: 'data.entity_id',
              op: 'not_starts_with',
              value: 'button.',
            },
          ],
        },
        {
          ...event,
          payload: {
            event_type: 'state_changed',
            data: {
              entity_id: 'button.device_info',
              new_state: { state: 'on' },
            },
          },
        },
      ),
    ).toBe(false);
  });

  it('renders known placeholders and leaves unknown placeholders intact', () => {
    const prompt = renderPromptTemplate(
      `${subscription.promptTemplate}\n{{unknown_key}}`,
      event,
    );

    expect(prompt).toContain('source=ha_main');
    expect(prompt).toContain('sub=door-open');
    expect(prompt).toContain('type=state_changed');
    expect(prompt).toContain('2026-03-12T10:00:00.000Z');
    expect(prompt).toContain('"entity_id": "binary_sensor.front_door"');
    expect(prompt).toContain('{{unknown_key}}');
  });

  it('builds a task prompt with optional instructions and channel reply contract', () => {
    const prompt = buildWebSocketTaskPrompt(
      {
        ...subscription,
        taskInstructions:
          'Handle this according to my home preferences for {{event_type}}.',
        deliverOutput: true,
      },
      event,
    );

    expect(prompt).toContain(
      'Handle this according to my home preferences for state_changed.',
    );
    expect(prompt).toContain('Channel reply requirements:');
    expect(prompt).toContain(
      'Decide whether this event needs a user-facing reply.',
    );
    expect(prompt).toContain(
      'If no user-visible update is needed, return only <internal>...</internal> content.',
    );
    expect(prompt).toContain('source=ha_main');
  });
});
