---
name: add-imessage
description: Add iMessage as a channel using adapter backends (BlueBubbles preferred, SMServer fallback placeholder). Trigger when user asks for iMessage integration, BlueBubbles bridge, or Apple Messages channel.
---

# Add iMessage Channel

This skill installs iMessage channel code via the skills engine and provides a minimal setup flow.

## Credentials / Environment

Required:

- `IMESSAGE_ACCOUNT` - Account/identity used to tag self-messages (e.g. phone/email identity in your iMessage bridge)
- `NANOCLAW_IMESSAGE_BACKEND` - `bluebubbles` or `smserver`

BlueBubbles backend (recommended):

- `BLUEBUBBLES_URL` - Base URL of BlueBubbles server (e.g. `http://127.0.0.1:1234`)
- `BLUEBUBBLES_PASSWORD` - API password

SMServer backend (placeholder path for now):

- `SMSERVER_URL` - Base URL of SMServer instance

Security hardening (recommended):

- `NANOCLAW_IMESSAGE_ALLOWED_HOSTS` - Comma-separated explicit remote host allowlist
- `NANOCLAW_IMESSAGE_ALLOW_INSECURE_HTTP` - Default `false`; only relax for controlled environments
- `NANOCLAW_IMESSAGE_ENABLE_DIRECT_CHATDB` - High-risk mode switch
- `NANOCLAW_IMESSAGE_I_UNDERSTAND_CHATDB_RISKS` - Must be `true` to confirm high-risk mode
- `NANOCLAW_IMESSAGE_RECONNECT_INITIAL_DELAY_MS` / `NANOCLAW_IMESSAGE_RECONNECT_MAX_DELAY_MS` - Exponential backoff reconnect window
- `NANOCLAW_IMESSAGE_SEND_RATE_LIMIT_PER_SECOND` - Outbound send rate cap
- `NANOCLAW_IMESSAGE_SEND_QUEUE_MAX_SIZE` - Outbound queue cap before dead-letter

Compatibility aliases often requested by users:

- `IMESSAGE_BACKEND_URL` (map to backend URL)
- `IMESSAGE_AUTH_TOKEN` (map to backend auth token/password)

## Minimal runnable steps

1. Initialize skills state (first time only):

```bash
npx tsx scripts/apply-skill.ts --init
```

2. Apply this skill package:

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-imessage
```

3. Add credentials to `.env` (BlueBubbles example):

```bash
IMESSAGE_ACCOUNT=me@icloud.com
NANOCLAW_IMESSAGE_BACKEND=bluebubbles
BLUEBUBBLES_URL=https://127.0.0.1:1234
BLUEBUBBLES_PASSWORD=replace-me
```

4. Sync env for worker runtime:

```bash
mkdir -p data/env && cp .env data/env/env
```

5. Build and restart service:

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Smoke checks (static, no real account required)

```bash
bash scripts/smoke-add-imessage-skill.sh
```

## Security notes

- Use `.env` + `readEnvFile` pattern for credentials; avoid exporting bridge tokens broadly in shell profiles.
- External bridge URLs should be `https` and allowlisted.
- Direct `chat.db` access is high risk and requires explicit confirmation env vars.

## Dead-letter replay

Failed outbound messages are written to `logs/imessage-dead-letter.jsonl`.

```bash
node scripts/replay-imessage-dead-letter.mjs           # dry run
node scripts/replay-imessage-dead-letter.mjs --execute # replay (BlueBubbles)
```

## Troubleshooting

- **Channel skipped at startup**: check logs for missing `IMESSAGE_ACCOUNT` or backend credentials.
- **Primary backend fails health check**: set `NANOCLAW_IMESSAGE_FALLBACK_BACKEND` and provide fallback credentials.
- **Duplicate messages after reconnect**: inbound dedupe key is `platform_message_id + chat_id`; verify adapter emits stable IDs.

## Rollback

If you want to remove this skill from a customized installation, use your existing skills engine uninstall/replay flow (or restore from your git commit before apply).
