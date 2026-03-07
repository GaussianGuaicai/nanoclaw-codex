# NanoClaw Debug Checklist

## Known Issues (2026-03-07)

### 1. IDLE_TIMEOUT == AGENT_TIMEOUT (both 30 min)
Both timers fire at the same time, so workers can still exit via hard kill instead of graceful `_close` shutdown. The idle timeout should eventually be shorter so workers wind down between messages, while the hard timeout remains a safety net for stuck runs.

### 2. Cursor advanced before agent succeeds
`processGroupMessages` advances `lastAgentTimestamp` before the agent finishes. If the worker fails before sending output, retries can miss messages unless the rollback path triggers correctly.

## Quick Status Check

```bash
# 1. Is the service running?
launchctl list | grep nanoclaw

# 2. Is the local worker build present?
ls -la container/agent-runner/dist/index.js

# 3. Recent warnings/errors in the service log
grep -E 'ERROR|WARN' logs/nanoclaw.log | tail -20

# 4. Is WhatsApp connected?
grep -E 'Connected to WhatsApp|Connection closed|connection.*close' logs/nanoclaw.log | tail -5

# 5. Are groups loaded?
grep 'groupCount' logs/nanoclaw.log | tail -3
```

## Worker Timeout Investigation

```bash
# Check for recent worker timeouts
grep -E 'Worker timed out|timed out' logs/nanoclaw.log | tail -10

# Check worker run logs
ls -lt groups/*/logs/worker-*.log | head -10

# Read the most recent worker log
cat groups/<group>/logs/worker-<timestamp>.log

# Check retries
grep -E 'Scheduling retry|retry|Max retries' logs/nanoclaw.log | tail -10
```

## Agent Not Responding

```bash
# Check inbound messages
grep 'New messages' logs/nanoclaw.log | tail -10

# Check if workers are being launched
grep -E 'Processing messages|Spawning local Codex worker|Starting worker' logs/nanoclaw.log | tail -10

# Check if messages are being piped to an active worker
grep -E 'Piped messages|sendMessage' logs/nanoclaw.log | tail -10

# Check the queue state
grep -E 'Worker active|Starting worker|concurrency limit' logs/nanoclaw.log | tail -10

# Compare lastAgentTimestamp vs latest message timestamp
sqlite3 store/messages.db "SELECT chat_jid, MAX(timestamp) as latest FROM messages GROUP BY chat_jid ORDER BY latest DESC LIMIT 5;"
```

## Writable Roots / Snapshot Issues

```bash
# Check allowlist validation and path mapping logs
grep -E 'Mount validated|Mount.*REJECTED|layout|writableRoots|additionalDirectories' logs/nanoclaw.log | tail -20

# Verify the mount allowlist
cat ~/.config/nanoclaw/mount-allowlist.json

# Check group's compatibility config in DB
sqlite3 store/messages.db "SELECT name, container_config FROM registered_groups;"

# Inspect the latest worker layout snapshot
grep -n 'Runtime Layout' -A40 groups/<group>/logs/worker-<timestamp>.log
```

## IPC / Task Issues

```bash
# Inspect per-group IPC state
find data/ipc -maxdepth 2 -type f | sort

# Read current task snapshot for a group
cat data/ipc/<group-folder>/current_tasks.json

# Read available groups snapshot
cat data/ipc/<group-folder>/available_groups.json
```

## WhatsApp Auth Issues

```bash
# Check if QR code was requested
grep 'QR\\|authentication required\\|qr' logs/nanoclaw.log | tail -5

# Check auth files exist
ls -la store/auth/

# Re-authenticate if needed
npm run auth
```

## Service Management

```bash
# Restart the service
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# View live logs
tail -f logs/nanoclaw.log

# Stop the service (careful — running workers are detached, not killed)
launchctl bootout gui/$(id -u)/com.nanoclaw

# Start the service
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.nanoclaw.plist

# Rebuild after code changes
npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```
