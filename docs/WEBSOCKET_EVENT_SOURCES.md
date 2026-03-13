# WebSocket Event Sources

NanoClaw can now consume host-side WebSocket event sources and turn them into immediate agent tasks.

## Config file

Create the host-only config file at:

```text
~/.config/nanoclaw/websocket-sources.json
```

Use `config-examples/websocket-sources.home-assistant.json` as a Home Assistant-oriented starting point.

## Supported v1 behavior

- Client mode only. NanoClaw connects out to external WebSocket APIs.
- First implemented provider: Home Assistant.
- Providers register themselves through the event-source registry; the manager no longer imports provider classes directly.
- Subscription mode: `subscribe_events` only.
- Events trigger immediate tasks targeting an existing registered `targetJid`.
- Default behavior is silent execution with `contextMode: "isolated"`.
- Events that pass filtering are appended as JSONL to provider-specific files such as `logs/websocket-events-home_assistant.log`.
- `filtered` and `cooldown` events are not logged unless explicitly enabled in the subscription.

## Runtime Shape

- `src/event-sources/base.ts`: provider-agnostic WebSocket connection lifecycle
- `src/event-sources/registry.ts`: provider factory registry
- `src/event-sources/providers.ts`: side-effect barrel that loads built-in providers
- `src/event-sources/home-assistant.ts`: Home Assistant protocol implementation and self-registration
- `src/event-sources/event-log.ts`: provider-specific JSONL event logging

## Connection fields

- `provider`: provider name; current implementation supports `"home_assistant"`
- `urlEnvVar`: env var containing the provider base URL or WebSocket URL
- `tokenEnvVar`: env var containing the provider access token or equivalent credential
- `heartbeatIntervalMs`: optional ping interval
- `requestTimeoutMs`: optional per-request timeout
- `reconnect.initialDelayMs`: optional reconnect backoff start
- `reconnect.maxDelayMs`: optional reconnect backoff cap
- `features.coalesceMessages`: optional provider-specific flag currently used by Home Assistant

## Subscription fields

- `id`: unique subscription id
- `connection`: connection name from `connections`
- `kind`: currently only `"events"`
- `eventType`: provider event type for the subscription
- `filters`: optional generic filter rules evaluated against the provider payload
- `match`: optional exact-match filters using dot-paths relative to the normalized provider payload
- `logFilteredEvents`: optional boolean; defaults to `false`
- `logCooldownEvents`: optional boolean; defaults to `false`
- `runTask`: optional boolean; defaults to `true`. Set to `false` for log-only subscriptions.
- `logTaskResult`: optional boolean; defaults to `false`. When enabled, task result text is written into the corresponding `worker-*.log` file.
- `targetJid`: registered group/chat JID that owns the task context
- `promptTemplate`: required task prompt template
- `contextMode`: `"isolated"` or `"group"`
- `deliverOutput`: whether the task result should be sent back to the target chat
- `cooldownMs`: optional per-subscription suppression window

## Prompt template variables

- `{{connection_name}}`
- `{{subscription_id}}`
- `{{event_type}}`
- `{{time_fired}}`
- `{{event_json}}`

## Generic filter rules

Each rule reads from `path` relative to the provider payload and applies `op`.

- `eq`
- `neq`
- `in`
- `not_in`
- `starts_with`
- `not_starts_with`
- `exists`
- `not_exists`

`valueFromPath` can be used instead of `value` to compare two payload paths, which makes rules reusable across providers. Example:

```json
{
  "path": "data.old_state.state",
  "op": "neq",
  "valueFromPath": "data.new_state.state"
}
```

## Event Logs

- Log files are split by provider name.
- Current Home Assistant file: `logs/websocket-events-home_assistant.log`
- Provider names are normalized to lowercase and non-alphanumeric characters are converted to `-`.
- The old shared `logs/websocket-events.log` file is a legacy artifact if it exists; new events are written to provider-specific files.
- If `runTask` is `false`, matching events are still logged with status `logged` but no agent worker is spawned.
- `logTaskResult` only matters when `runTask` is not `false`; prompt and result are written into the matching `groups/<group>/logs/worker-*.log` file.
