# NanoClaw Security Model

## Trust Model

| Entity | Trust Level | Rationale |
|--------|-------------|-----------|
| Main group | Trusted | Private self-chat, admin control |
| Non-main groups | Lower trust | Other users may be malicious |
| Codex workers | Sandboxed | Restricted by Codex sandbox plus host-prepared paths |
| Channel messages | User input | Potential prompt injection |

## Primary Boundaries

### 1. Host-Orchestrated Codex Sandbox

Agents no longer run in Linux containers. Each invocation starts a local Codex worker with:

- `sandbox_mode=workspace-write`
- `approval_policy=never`
- a per-group working directory
- host-selected extra writable roots
- optional read-only snapshots copied into a group-scoped context directory

This is weaker isolation than the old container model. The boundary is now the Codex sandbox plus what the host process decides to expose.

### 2. Group-Scoped State

Each group gets isolated local Codex state at `data/sessions/{group}/.codex`.

That directory is used as `CODEX_HOME`, so groups do not share:

- Codex session transcripts
- local auth state
- Codex logs and caches
- resumable thread metadata

### 3. Mount Allowlist Compatibility

Group `containerConfig.additionalMounts` is still accepted, but interpreted differently:

- read-only mounts become copied snapshots under a per-group sandbox context directory
- read-write mounts become extra writable roots only if allowed by `~/.config/nanoclaw/mount-allowlist.json`

Protections kept from the old model:

- allowlist stored outside the repo
- symlink resolution before validation
- blocked path patterns such as `.ssh`, `.gnupg`, `.aws`, `.env`, `id_rsa`
- optional forced read-only behavior for non-main groups

### 4. IPC Authorization

The host still owns all messaging and task side effects.

| Operation | Main Group | Non-Main Group |
|-----------|------------|----------------|
| Send message to own chat | ✓ | ✓ |
| Send message to other chats | ✓ | ✗ |
| Schedule task for self | ✓ | ✓ |
| Schedule task for others | ✓ | ✗ |
| View all tasks | ✓ | Own only |
| Manage other groups | ✓ | ✗ |

Workers can only request those actions through the local MCP/IPC bridge. Authorization is enforced by the host process when IPC files are consumed.

### 5. Credential Handling

The worker receives only a filtered set of runtime secrets from `.env`:

- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `NANOCLAW_CODEX_*`

These secrets are passed from host to worker input, then used to configure Codex. The worker does not blindly inherit the host shell environment, and Codex subprocesses are started with a minimal environment plus `CODEX_HOME`.

For the main group, the project root is exposed as a per-run snapshot with `.env`
removed, so only the filtered runtime secrets above reach the worker.

Host-only secrets remain outside the worker runtime:

- channel auth state under `store/`
- mount allowlist config
- sender allowlist config

## Effective Access Model

| Capability | Main Group | Non-Main Group |
|------------|------------|----------------|
| Group folder | read-write | read-write |
| Project root | read-only sanitized snapshot | none by default |
| Global memory | available via snapshot or repo access | snapshot copy |
| Extra readonly mounts | snapshot copies | snapshot copies |
| Extra read-write mounts | allowlist-controlled | usually blocked or forced readonly |
| Network access | enabled by default | enabled by default |

## Residual Risks

- Codex sandbox is not equivalent to container or VM isolation.
- Read-only snapshots can drift from the source between runs because they are copied, not mounted live.
- If a writable root is approved by the host allowlist, Codex can mutate it directly.

## Security Architecture Diagram

```text
Untrusted messages
  -> host router / DB / IPC authorization
  -> host prepares working dir, snapshots, writable roots
  -> local Codex worker
  -> Codex sandbox + MCP bridge
  -> host applies side effects
```
