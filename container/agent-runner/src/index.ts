/**
 * NanoClaw Agent Runner
 * Runs as a local worker process, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to the host-provided IPC input directory
 *          Files: {type:"message"|"background_activity", text:"..."}.json — polled and consumed
 *          Sentinel: _close inside that IPC input directory — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveMcpServerLaunch } from './mcp-launch.js';
import { createAgentRuntime } from './runtime/index.js';
import { ContainerInput, IpcInputMessage } from './runtime/types.js';

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  usage?: import('./runtime/types.js').TurnUsage;
}

const IPC_POLL_MS = 500;

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
function drainIpcInput(ipcInputDir: string): IpcInputMessage[] {
  try {
    fs.mkdirSync(ipcInputDir, { recursive: true });
    const files = fs.readdirSync(ipcInputDir)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: IpcInputMessage[] = [];
    for (const file of files) {
      const filePath = path.join(ipcInputDir, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (
          (data.type === 'message' || data.type === 'background_activity') &&
          data.text
        ) {
          messages.push({ type: data.type, text: data.text });
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Check for _close sentinel.
 */
function shouldClose(closeSentinelPath: string): boolean {
  if (fs.existsSync(closeSentinelPath)) {
    try { fs.unlinkSync(closeSentinelPath); } catch { /* ignore */ }
    return true;
  }
  return false;
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages as a single string, or null if _close.
 */
function waitForIpcMessage(
  ipcInputDir: string,
  closeSentinelPath: string,
): Promise<{ prompt: string; backgroundOnly: boolean } | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose(closeSentinelPath)) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput(ipcInputDir);
      if (messages.length > 0) {
        resolve(promptFromIpcMessages(messages));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

function mergePendingMessages(prompt: string, ipcInputDir: string): string {
  const pending = drainIpcInput(ipcInputDir);
  if (pending.length === 0) {
    return prompt;
  }

  log(`Draining ${pending.length} pending IPC messages into prompt`);
  return `${prompt}\n${pending.map((message) => message.text).join('\n')}`;
}

function promptFromIpcMessages(messages: IpcInputMessage[]): {
  prompt: string;
  backgroundOnly: boolean;
} {
  return {
    prompt: messages.map((message) => message.text).join('\n'),
    backgroundOnly: messages.every(
      (message) => message.type === 'background_activity',
    ),
  };
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  // Build SDK env: merge secrets into process.env for the SDK only.
  // Secrets never touch process.env itself, so Bash subprocesses can't see them.
  const sdkEnv: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(containerInput.secrets || {})) {
    sdkEnv[key] = value;
  }

  if (!containerInput.runtimePaths) {
    throw new Error('Missing runtimePaths in worker input');
  }

  const ipcInputDir = path.join(containerInput.runtimePaths.ipcPath, 'input');
  const closeSentinelPath = path.join(ipcInputDir, '_close');

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServer = resolveMcpServerLaunch(__dirname);
  const runtime = createAgentRuntime(
    {
      onLog: log,
      onResult: (result, newSessionId, usage) => {
        writeOutput({ status: 'success', result, newSessionId, usage });
      },
    },
    {
      shouldClose: () => shouldClose(closeSentinelPath),
      drainIpcInput: () => drainIpcInput(ipcInputDir),
      ipcPollMs: IPC_POLL_MS,
    },
  );

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(ipcInputDir, { recursive: true });

  try { fs.unlinkSync(closeSentinelPath); } catch { /* ignore */ }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  prompt = mergePendingMessages(prompt, ipcInputDir);

  // Query loop: run query → wait for IPC message → run new query → repeat
  let resumeAt: string | undefined;
  let backgroundOnly = false;
  try {
    while (true) {
      if (shouldClose(closeSentinelPath)) {
        log('Close sentinel received before query start, exiting');
        break;
      }

      prompt = mergePendingMessages(prompt, ipcInputDir);
      log(`Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`);

      const queryResult = await runtime.runQuery({
        prompt,
        backgroundOnly,
        sessionId,
        mcpServerCommand: mcpServer.command,
        mcpServerArgs: mcpServer.args,
        containerInput,
        sdkEnv,
        resumeAt,
      });
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      if (queryResult.nextPrompt != null) {
        log(
          `Restarting query with IPC follow-up input (${queryResult.nextPrompt.length} chars)`,
        );
        prompt = queryResult.nextPrompt;
        backgroundOnly = queryResult.nextPromptBackgroundOnly === true;
        continue;
      }

      backgroundOnly = false;

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      // Maintenance tasks are one-shot internal runs with no follow-up IPC input.
      // Exiting here prevents them from idling until the outer host timeout.
      if (containerInput.maintenancePurpose === 'summary-memory') {
        log(
          `Maintenance query completed (${containerInput.maintenancePurpose}), exiting`,
        );
        break;
      }

      log('Query ended, waiting for next IPC message...');

      const nextMessage = await waitForIpcMessage(
        ipcInputDir,
        closeSentinelPath,
      );
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new IPC input (${nextMessage.prompt.length} chars), starting new query`);
      prompt = nextMessage.prompt;
      backgroundOnly = nextMessage.backgroundOnly;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage,
    });
    process.exit(1);
  }
}

main();
