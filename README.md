<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  A personal AI assistant that runs agents in isolated containers. This fork keeps NanoClaw's small-core, skill-first architecture and adds OpenAI Codex as an alternative runtime alongside Anthropic.
</p>

<p align="center">
  <a href="https://nanoclaw.dev">nanoclaw.dev</a>&nbsp; • &nbsp;
  <a href="README_zh.md">中文</a>&nbsp; • &nbsp;
  <a href="https://github.com/GaussianGuaicai/nanoclaw-codex">Fork</a>&nbsp; • &nbsp;
  <a href="https://discord.gg/VDdww8qS42"><img src="https://img.shields.io/discord/1470188214710046894?label=Discord&logo=discord&v=2" alt="Discord" valign="middle"></a>&nbsp; • &nbsp;
  <a href="repo-tokens"><img src="repo-tokens/badge.svg" alt="34.9k tokens, 17% of context window" valign="middle"></a>
</p>

This repository tracks [upstream NanoClaw](https://github.com/qwibitai/nanoclaw) and keeps its original operating model: one small Node.js orchestrator, channels added through skills, per-group memory, and real container isolation instead of application-only permission checks. The main difference in this fork is the runtime inside each group container: you can keep using Anthropic/Claude, or switch to Codex.

## What This Fork Changes

- Adds provider switching with `NANOCLAW_AGENT_PROVIDER=anthropic|codex`
- Keeps Anthropic runtime support via `@anthropic-ai/claude-agent-sdk`
- Adds Codex runtime support via `@openai/codex-sdk`
- Passes through `OPENAI_API_KEY`, `OPENAI_BASE_URL`, and `NANOCLAW_CODEX_*` controls into the container runtime
- Mounts a per-group `.codex` directory alongside the existing per-group `.claude` directory
- Preserves upstream's skill-based customization, scheduler, IPC, and security model

## Why NanoClaw

[OpenClaw](https://github.com/openclaw/openclaw) is an impressive project, but I did not want to hand broad access to a large codebase I could not realistically audit. NanoClaw keeps the same core idea in a codebase small enough to understand: one process, a small number of files, and agents that run inside real Linux containers with explicit mounts.

## Quick Start

```bash
git clone https://github.com/GaussianGuaicai/nanoclaw-codex.git
cd nanoclaw-codex
claude
```

Then run `/setup`.

The setup flow is still Claude Code skill-driven. It bootstraps dependencies, configures Docker or Apple Container, installs channel skills, and writes the service configuration for you.

> **Note:** Commands prefixed with `/` (like `/setup`, `/add-whatsapp`, `/customize`) are [Claude Code skills](https://code.claude.com/docs/en/skills). Run them inside the `claude` CLI prompt, not in your regular shell.

If you want to debug setup outside the skill, the underlying steps live in `setup/` and are invoked with `bash setup.sh` plus `npx tsx setup/index.ts --step ...`.

## Choose The Agent Runtime

| Runtime | Setting | Auth | Notes |
|---------|---------|------|-------|
| Anthropic | `NANOCLAW_AGENT_PROVIDER=anthropic` or unset | `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` | Most mature path; matches upstream behavior most closely |
| Codex | `NANOCLAW_AGENT_PROVIDER=codex` | `OPENAI_API_KEY` | Uses `@openai/codex-sdk`; supports provider-specific controls via `NANOCLAW_CODEX_*` |

Example `.env`:

```bash
# Anthropic / Claude (default)
NANOCLAW_AGENT_PROVIDER=anthropic
CLAUDE_CODE_OAUTH_TOKEN=...

# Or switch the in-container runtime to Codex
# NANOCLAW_AGENT_PROVIDER=codex
# OPENAI_API_KEY=sk-...
# OPENAI_BASE_URL=https://your-openai-compatible-endpoint.com
# NANOCLAW_CODEX_MODEL=gpt-5-codex
# NANOCLAW_CODEX_SANDBOX_MODE=workspace-write
# NANOCLAW_CODEX_APPROVAL_POLICY=never
# NANOCLAW_CODEX_NETWORK_ACCESS=false
# NANOCLAW_CODEX_WEB_SEARCH_ENABLED=false
# NANOCLAW_CODEX_WEB_SEARCH_MODE=disabled
# NANOCLAW_CODEX_REASONING_EFFORT=medium
```

The Codex path also mounts a per-group `.codex` directory to `/home/node/.codex`. If you want to experiment with login-based auth, you can manage that directory yourself, but the straightforward documented path in this fork is `OPENAI_API_KEY`.

### Current Codex Status

Codex support is functional, but it is not yet full Anthropic parity.

- The adapter lives in `container/agent-runner/src/runtime/codex-runtime.ts`
- It currently runs one prompt to one final response per loop iteration
- It resumes by thread ID, but currently ignores Anthropic's `resumeAt` cursor
- Tool and hook parity are still being aligned

For the current migration surface and open gaps, see [docs/migration/anthropic-to-codex-mapping.md](docs/migration/anthropic-to-codex-mapping.md).

## Philosophy

**Small enough to understand.** One process, a few source files, and no microservices.

**Secure by isolation.** Agents run in Linux containers and only see explicitly mounted directories.

**Built for the individual user.** The project is meant to be forked and changed, not configured into a giant generic platform.

**Skills over built-ins.** Channels and optional integrations are added as skills so the core stays small.

**AI-native operations.** Setup, debugging, and customization are intended to happen through the coding agent rather than admin dashboards.

## What The Core Ships With

- Dual runtime support: Anthropic by default, Codex optionally
- Group-isolated memory via `groups/*/AGENTS.md`
- Per-group filesystem isolation and container mounts
- Scheduled tasks that run inside the same isolated runtime
- File-based IPC between the host orchestrator and the container
- A skill system for installing channels and optional integrations

The core intentionally does **not** bundle channel implementations. Channel code is added by skills that patch `src/channels/` and self-register at startup. This repo already includes official skills for:

- `/add-whatsapp`
- `/add-telegram`
- `/add-slack`
- `/add-discord`
- `/add-gmail`

## Usage

Talk to your assistant with the trigger word (default: `@Andy`):

```text
@Andy send an overview of the sales pipeline every weekday morning at 9am (has access to my Obsidian vault folder)
@Andy review the git history for the past week each Friday and update the README if there's drift
@Andy every Monday at 8am, compile news on AI developments and message me a briefing
```

From the main channel (your self-chat), you can manage groups and tasks:

```text
@Andy list all scheduled tasks across groups
@Andy pause the Monday briefing task
@Andy join the Family Chat group
```

## Customizing

NanoClaw favors code changes over sprawling configuration.

Tell Claude Code what you want:

- "Change the trigger word to @Bob"
- "Remember that responses should be shorter and more direct"
- "Add a custom greeting when I say good morning"
- "Store conversation summaries weekly"

Or run `/customize` for a guided flow.

## Requirements

- macOS or Linux
- Node.js 20+
- [Claude Code](https://claude.ai/download) for `/setup`, `/customize`, and the existing skill workflow
- One auth path for your chosen runtime:
  - Anthropic: `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`
  - Codex: `OPENAI_API_KEY`
- [Apple Container](https://github.com/apple/container) (macOS) or [Docker](https://docker.com/products/docker-desktop) (macOS/Linux)

## Development

```bash
npm run dev
npm run build
npm test
./container/build.sh
```

## Architecture

```text
Channels --> SQLite --> Polling loop --> Container runner --> Anthropic or Codex runtime --> Response
```

Single Node.js process. Installed channels self-register at startup. The orchestrator connects whichever channels have credentials present, queues work per group, and spawns isolated agent containers. The container runner mounts only the directories allowed for that group, starts the provider-specific runtime, and exchanges messages/tasks through filesystem IPC.

For the baseline architecture, see [docs/SPEC.md](docs/SPEC.md). For Codex-specific runtime deltas, see [docs/migration/anthropic-to-codex-mapping.md](docs/migration/anthropic-to-codex-mapping.md).

Key files:

- `src/index.ts` - Orchestrator: state, message loop, agent invocation
- `src/channels/registry.ts` - Channel registry and self-registration
- `src/container-runner.ts` - Mounts, secret handoff, and container process management
- `src/ipc.ts` - IPC watcher and task processing
- `src/router.ts` - Message formatting and outbound routing
- `src/group-queue.ts` - Per-group queue with a global concurrency limit
- `src/task-scheduler.ts` - Scheduled task execution
- `src/db.ts` - SQLite operations (messages, groups, sessions, state)
- `container/agent-runner/src/runtime/anthropic-runtime.ts` - Anthropic provider implementation
- `container/agent-runner/src/runtime/codex-runtime.ts` - Codex provider implementation
- `groups/*/AGENTS.md` - Per-group memory

## Security

The security model is the same as upstream NanoClaw: the primary boundary is container isolation, not prompt-level allowlists. The main group gets the project mounted read-only plus explicit writable mounts; non-main groups only get their own workspace plus the global memory directory read-only. External mounts are validated against an allowlist stored outside the project root.

See [docs/SECURITY.md](docs/SECURITY.md) for the baseline model and [docs/migration/anthropic-to-codex-mapping.md](docs/migration/anthropic-to-codex-mapping.md) for Codex-specific auth/runtime additions.

## FAQ

**Do I still need Claude Code if I want to run Codex inside NanoClaw?**

Yes, for the current setup and customization workflow. This fork changes the runtime inside the container, not the existing slash-skill based host workflow.

**Are channels bundled in core?**

No. The core channel barrel (`src/channels/index.ts`) is intentionally empty until a skill adds imports and channel files. This repository includes skills for the common channels, but you install them into your fork when you want them.

**Can I run this on Linux?**

Yes. Docker is the default runtime and works on macOS and Linux. Apple Container is available on macOS.

**Can I use third-party or self-hosted model endpoints?**

Yes.

For Anthropic-compatible endpoints:

```bash
ANTHROPIC_BASE_URL=https://your-api-endpoint.com
ANTHROPIC_AUTH_TOKEN=your-token-here
```

For Codex-compatible endpoints:

```bash
NANOCLAW_AGENT_PROVIDER=codex
OPENAI_BASE_URL=https://your-openai-compatible-endpoint.com
OPENAI_API_KEY=your-token-here
```

**Is this secure?**

It is designed around OS-level isolation. Agents run in containers and can only access explicitly mounted directories. You should still review what you run, but the main security boundary is the container, not an in-process permission filter.

**How do I debug issues?**

Ask the coding agent. The intended workflow remains AI-native: inspect logs, check the scheduler, review recent container output, and patch the code when needed.

## Contributing

**Don't add features. Add skills.**

If you want to add Telegram support, don't create a PR that permanently grows the core. Instead, contribute a skill like `.claude/skills/add-telegram/` that teaches Claude Code how to transform a NanoClaw installation.

That keeps the base system small while still letting each user compose the exact setup they want.

## Community

Questions? Ideas? [Join the Discord](https://discord.gg/VDdww8qS42).

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for breaking changes and migration notes.

## License

MIT
