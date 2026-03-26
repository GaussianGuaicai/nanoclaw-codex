# Home Assistant REST API Reference

## Authentication And Base URL

- REST API shares the frontend port. Default base URL is `http://<host>:8123`.
- The API root is `/api/`, and the health check path must include the trailing slash.
- The API accepts and returns JSON.
- Send `Authorization: Bearer <token>` on every request.
- Use a Home Assistant access token, typically a long-lived access token from the user's profile page.
- If Home Assistant is running without the frontend, enable the `api` integration in `configuration.yaml`.

## Agent Workflow

1. Confirm connectivity with `GET /api/`.
2. Inspect `GET /api/config` for version, time zone, and config metadata.
3. Discover available actions with `GET /api/services`.
4. Read the target entity with `GET /api/states/<entity_id>`.
5. For a real action, call `POST /api/services/<domain>/<service>`.
6. For templates, synthetic states, events, history, or config validation, use the specialized endpoints below.
7. If something looks wrong, check `GET /api/error_log` and `GET /api/history/period/<timestamp>`.

## Endpoint Map

| Method | Path | Use | Notes |
| --- | --- | --- | --- |
| GET | `/api/` | Health check | Returns `"API running."` when reachable. |
| GET | `/api/config` | Core config | Useful for version, time zone, and config dir. |
| GET | `/api/components` | Loaded components | Helpful when an integration is missing. |
| GET | `/api/events` | Event inventory | Lists event names and listener counts. |
| GET | `/api/services` | Service inventory | Inspect domains before calling services. |
| GET | `/api/states` | All entity states | Snapshot of current states. |
| GET | `/api/states/<entity_id>` | One entity state | Returns 404 if the entity is missing. |
| GET | `/api/history/period/<timestamp>` | Historical state changes | `filter_entity_id` is required; optional `end_time`, `minimal_response`, `no_attributes`, `significant_changes_only`. |
| GET | `/api/error_log` | Current-session errors | Plain-text response. |
| GET | `/api/camera_proxy/<camera entity_id>` | Camera image bytes | Returns the raw camera image. |
| GET | `/api/calendars` | Calendar entities | Lists calendars. |
| POST | `/api/events/<event_type>` | Fire a custom event | Pass `event_data` JSON. |
| POST | `/api/services/<domain>/<service>` | Call a service | Pass `service_data` JSON. Use `?return_response` only when supported or required. |
| POST | `/api/template` | Render a Jinja template | Returns rendered text, not JSON. |
| POST | `/api/config/core/check_config` | Validate config | Requires config integration. |
| POST | `/api/intent/handle` | Handle an intent | Requires intent integration. |
| POST | `/api/states/<entity_id>` | Create or update synthetic state | Useful for tests or custom sensors. |
| DELETE | `/api/states/<entity_id>` | Delete synthetic state | Removes the synthetic entity state. |

## Common Payloads

Inspect a single entity:

```bash
curl -H "Authorization: Bearer $HA_TOKEN" \
  -H "Content-Type: application/json" \
  "$HA_URL/api/states/light.kitchen"
```

Turn a light on:

```bash
curl -X POST \
  -H "Authorization: Bearer $HA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"entity_id":"light.kitchen"}' \
  "$HA_URL/api/services/light/turn_on"
```

Render a template:

```bash
curl -X POST \
  -H "Authorization: Bearer $HA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"template":"{{ states(\"sensor.outdoor_temperature\") }}"}' \
  "$HA_URL/api/template"
```

Create a synthetic state:

```bash
curl -X POST \
  -H "Authorization: Bearer $HA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"state":"72","attributes":{"unit_of_measurement":"F"}}' \
  "$HA_URL/api/states/sensor.kitchen_temperature"
```

## Troubleshooting

- `400` usually means invalid JSON, a missing required field, or incorrect `?return_response` usage.
- `401` means the token is missing, expired, or copied incorrectly.
- `404` usually means the entity, service, or path is wrong.
- `405` usually means the wrong HTTP method was used.
- `POST /api/services/<domain>/<service>` returns a list of state changes during execution, and may include response data if supported by the service.
- `POST /api/states/<entity_id>` updates Home Assistant's state model, not the physical device.
- Use the user's configured Home Assistant host, not `localhost`, unless the agent is running on the Home Assistant machine.
