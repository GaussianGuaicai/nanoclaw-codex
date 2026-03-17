# iMessage Security Notes

This document explains security boundaries and operational risk when enabling iMessage bridges in NanoClaw.

## 1) Bridge Risk Model

NanoClaw does **not** talk to Apple iMessage APIs directly. It depends on a local bridge/backend such as:

- BlueBubbles (preferred)
- SMServer (placeholder support path)
- Other custom adapters (future)

That means your effective security posture depends on both NanoClaw **and** the bridge process.

### Key risks

- Bridge compromise can expose message content and metadata.
- Weak bridge auth can let other local/network actors send/receive messages.
- Insecure bridge transport (`http` over non-local networks) can leak credentials.

## 2) URL and Transport Guardrails

NanoClaw defaults to strict backend URL validation:

- Local addresses (`localhost`, loopback, RFC1918 private ranges) are allowed.
- Non-local addresses require `https`.
- Non-local hosts should be explicitly allowlisted by `NANOCLAW_IMESSAGE_ALLOWED_HOSTS`.
- Plaintext external `http` is rejected by default.

Optional relaxation (not recommended):

- `NANOCLAW_IMESSAGE_ALLOW_INSECURE_HTTP=true` only for explicitly allowlisted hosts.

## 3) Credentials Handling

iMessage bridge credentials are loaded from `.env` via `readEnvFile` (same pattern as other secure channels), instead of being required in process-wide environment variables.

This reduces accidental credential exposure to spawned subprocesses.

## 4) Structured Logging Redaction

NanoClaw logger applies structured-field redaction for common secrets and sensitive identifiers, including token/cookie/password/auth fields and chat-handle related fields.

Even with redaction enabled, do not log raw bridge payloads at debug level in production.

## 5) macOS Permission Considerations

Depending on bridge mode and host tooling, your macOS host may require permissions such as:

- Full Disk Access (for certain local database access workflows)
- Automation / Accessibility permissions (for AppleScript-based paths)

Grant only minimum required permissions to the specific service account running NanoClaw/bridge.

## 6) Apple ID Boundary

If bridge software runs on a machine signed into your Apple ID:

- Treat the host as highly sensitive.
- Assume local compromise could expose message history and account-linked metadata.
- Use strong OS account controls, disk encryption, and least-privileged service users.

## 7) High-Risk Mode: direct `chat.db` access

Directly reading iMessage `chat.db` is considered high risk.

NanoClaw requires explicit acknowledgement before this mode is allowed:

- `NANOCLAW_IMESSAGE_ENABLE_DIRECT_CHATDB=true`
- `NANOCLAW_IMESSAGE_I_UNDERSTAND_CHATDB_RISKS=true`

If the second variable is missing, NanoClaw logs an error and refuses to enable the risky mode.
