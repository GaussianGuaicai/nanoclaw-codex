import { CodexRuntime } from './codex-runtime.js';
import { AgentRuntime, RuntimeHooks, RuntimeIpc } from './types.js';

export function createAgentRuntime(
  hooks: RuntimeHooks,
  ipc: RuntimeIpc,
): AgentRuntime {
  return new CodexRuntime(hooks, ipc);
}
