---
name: home-assistant-rest-api
description: Work with Home Assistant's REST API for state inspection, service calls, template rendering, custom events, synthetic states, history, and REST authentication/debugging. Use when the user asks to query or control Home Assistant through `/api/*`, build a REST client, or troubleshoot 400/401/404/405 responses.
---

# Home Assistant REST API

## Quick Start

Use [references/rest-api.md](references/rest-api.md) as the canonical endpoint cheat sheet.

1. Confirm the Home Assistant base URL and bearer token.
2. Read `GET /api/` to verify connectivity.
3. Discover with `GET /api/states`, `GET /api/states/<entity_id>`, and `GET /api/services`.
4. Mutate state with `POST /api/services/<domain>/<service>`.
5. Use `POST /api/template` for Jinja evaluation and `GET /api/history/period/<timestamp>` or `GET /api/error_log` when debugging.

## Operating Rules

- Always send JSON and `Authorization: Bearer <token>`.
- Treat REST as a request/response API. Do not use it for subscriptions or streaming updates.
- Prefer read-only calls before any mutation.
- Use `POST /api/services/<domain>/<service>` for real device actions.
- Use `POST /api/states/<entity_id>` only for synthetic states or test fixtures, not physical device control.
- Add `?return_response` only when the service requires or supports response data.
- Check HTTP status first when debugging:
  - `200` or `201`: success
  - `400`: invalid payload or wrong `return_response`
  - `401`: token/auth problem
  - `404`: wrong entity, service, or path
  - `405`: wrong HTTP method

## Common Recipes

- Inspect a single entity with `GET /api/states/<entity_id>`.
- Enumerate service domains first with `GET /api/services`, then call the specific service.
- Render a template with `POST /api/template`.
- Validate config changes with `POST /api/config/core/check_config`.
- Fire custom events with `POST /api/events/<event_type>` only when the task specifically needs HA-side event signaling.
- Delete synthetic states with `DELETE /api/states/<entity_id>` when cleaning up test data.

## Reference

See [references/rest-api.md](references/rest-api.md) for endpoint details, payload shapes, curl examples, and troubleshooting notes.
