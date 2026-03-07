import { CodexRuntime } from './codex-runtime.js';
import { AgentRuntime, RuntimeHooks } from './types.js';

export function createAgentRuntime(
  hooks: RuntimeHooks,
): AgentRuntime {
  return new CodexRuntime(hooks);
}
