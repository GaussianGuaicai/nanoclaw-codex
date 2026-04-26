---
name: setup
description: Run initial NanoClaw setup. Use when user wants to install dependencies, authenticate messaging channels, register their main channel, or start the background services. Triggers on "setup", "install", "configure nanoclaw", or first-time setup requests.
---

# NanoClaw Setup

Run setup steps automatically. Only pause when user action is required (channel authentication, configuration choices). Setup uses `bash setup.sh` for bootstrap, then `npx tsx setup/index.ts --step <name>` for all other steps. Steps emit structured status blocks to stdout. Verbose logs go to `logs/setup.log`.

**Principle:** When something is broken or missing, fix it. Don't tell the user to go fix it themselves unless it genuinely requires their manual action (e.g. authenticating a channel, pasting a secret token). If a dependency is missing, install it. If a service won't start, diagnose and repair. Ask the user for permission when needed, then do the work.

**UX Note:** Ask user-facing questions directly and keep them narrow. In Codex, repo skills are invoked with `$skill-name` (for example `$add-whatsapp`), even though some older notes may still show slash-prefixed names.

## 1. Bootstrap (Node.js + Dependencies)

Run `bash setup.sh` and parse the status block.

- If NODE_OK=false → Node.js is missing or too old. Ask whether to install Node.js 22. If confirmed:
  - macOS: `brew install node@22` (if brew available) or install nvm then `nvm install 22`
  - Linux: `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs`, or nvm
  - After installing Node, re-run `bash setup.sh`
- If DEPS_OK=false → Read `logs/setup.log`. Try: delete `node_modules` and `package-lock.json`, re-run `bash setup.sh`. If native module build fails, install build tools (`xcode-select --install` on macOS, `build-essential` on Linux), then retry.
- If NATIVE_OK=false → better-sqlite3 failed to load. Install build tools and re-run.
- Record PLATFORM and IS_WSL for later steps.

## 2. Check Environment

Run `npx tsx setup/index.ts --step environment` and parse the status block.

- If HAS_AUTH=true → WhatsApp is already configured, note for step 5
- If HAS_REGISTERED_GROUPS=true → note existing config, offer to skip or reconfigure
- Record WORKER_BUILD for step 3

## 3. Local Worker Build

Run `npx tsx setup/index.ts --step worker` and parse the status block.

Run `npx tsx setup/index.ts --step container` only if an older setup flow still hardcodes the legacy step name. It is now an alias for the same local worker build.

**If BUILD_OK=false:** Read `logs/setup.log` tail for the build error.
- Common causes: missing Node dependencies, stale `node_modules`, or worker TypeScript errors. Fix the build issue and retry.

**If TEST_OK=false but BUILD_OK=true:** The worker compiled but the build artifact check failed. Re-run `npm run build` and inspect `container/agent-runner/dist/index.js`.

## 4. Codex Authentication (No Script)

If HAS_ENV=true from step 2, read `.env` and check for `OPENAI_API_KEY`. If present, confirm with user: keep or reconfigure?

Ask whether the existing OpenAI API key should be kept or replaced.

Tell user to add `OPENAI_API_KEY=<key>` to `.env`. Optionally add `OPENAI_BASE_URL` if they use a compatible proxy or self-hosted endpoint.

## 5. Set Up Channels

Ask which messaging channels to enable:
- WhatsApp (authenticates via QR code or pairing code)
- iMessage (local macOS Messages.app backend; requires Full Disk Access and AppleScript permission)
- Telegram (authenticates via bot token from @BotFather)
- Slack (authenticates via Slack app with Socket Mode)
- Discord (authenticates via Discord bot token)

**Delegate to each selected channel's own skill.** Each channel skill handles its own code installation, authentication, registration, and JID resolution. This avoids duplicating channel-specific logic and ensures JIDs are always correct.

For each selected channel, invoke its skill:

- **WhatsApp:** Invoke `$add-whatsapp`
- **iMessage:** Invoke `$add-imessage`
- **Telegram:** Invoke `$add-telegram`
- **Slack:** Invoke `$add-slack`
- **Discord:** Invoke `$add-discord`

Each skill will:
1. Install the channel code (via `apply-skill`)
2. Collect credentials/tokens or local permission settings as needed and write config to `.env`
3. Authenticate (WhatsApp QR/pairing, iMessage local permissions, or verify token-based connection)
4. Register the chat with the correct JID format
5. Build and verify

**After all channel skills complete**, continue to step 6.

## 6. Mount Allowlist

Ask whether the agent should have access to external directories.

**No:** `npx tsx setup/index.ts --step mounts -- --empty`
**Yes:** Collect paths/permissions. `npx tsx setup/index.ts --step mounts -- --json '{"allowedRoots":[...],"blockedPatterns":[],"nonMainReadOnly":true}'`

## 7. Start Service

If service already running: unload first.
- macOS: `launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist`
- Linux: `systemctl --user stop nanoclaw` (or `systemctl stop nanoclaw` if root)

Run `npx tsx setup/index.ts --step service` and parse the status block.

**If FALLBACK=wsl_no_systemd:** WSL without systemd detected. Tell user they can either enable systemd in WSL (`echo -e "[boot]\nsystemd=true" | sudo tee /etc/wsl.conf` then restart WSL) or use the generated `start-nanoclaw.sh` wrapper.

**If SERVICE_LOADED=false:**
- Read `logs/setup.log` for the error.
- macOS: check `launchctl list | grep nanoclaw`. If PID=`-` and status non-zero, read `logs/nanoclaw.error.log`.
- Linux: check `systemctl --user status nanoclaw`.
- Re-run the service step after fixing.

## 8. Verify

Run `npx tsx setup/index.ts --step verify` and parse the status block.

**If STATUS=failed, fix each:**
- SERVICE=stopped → `npm run build`, then restart: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `systemctl --user restart nanoclaw` (Linux) or `bash start-nanoclaw.sh` (WSL nohup)
- SERVICE=not_found → re-run step 7
- CREDENTIALS=missing → re-run step 4
- CHANNEL_AUTH shows `not_found` for any channel → re-invoke that channel's skill (e.g. `$add-telegram`)
- REGISTERED_GROUPS=0 → re-invoke the channel skills from step 5
- MOUNT_ALLOWLIST=missing → `npx tsx setup/index.ts --step mounts -- --empty`

Tell user to test: send a message in their registered chat. Show: `tail -f logs/nanoclaw.log`

## Troubleshooting

**Service not starting:** Check `logs/nanoclaw.error.log`. Common: wrong Node path (re-run step 7), missing `.env` (step 4), missing channel credentials (re-invoke channel skill).

**Worker fails to start:** Rebuild the local worker with `npm run build`. Check worker logs in `groups/main/logs/worker-*.log`.

**No response to messages:** Check trigger pattern. Main channel doesn't need prefix. Check DB: `npx tsx setup/index.ts --step verify`. Check `logs/nanoclaw.log`.

**Channel not connecting:** Verify the channel's required config is set in `.env` or the local permissions are in place. Channels auto-enable when their required config is present. For WhatsApp: check `store/auth/creds.json` exists. For iMessage: check `IMESSAGE_ENABLED=true`, `IMESSAGE_BACKEND=local-macos`, Full Disk Access, and AppleScript permission. For token-based channels: check token values in `.env`. Restart the service after any `.env` change.

**Unload service:** macOS: `launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist` | Linux: `systemctl --user stop nanoclaw`
