import { execFile } from 'child_process';
import { promisify } from 'util';

import { IMessageChatTarget } from '../backend.js';

const execFileAsync = promisify(execFile);

function escapeAppleScriptString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

function scriptForTarget(target: IMessageChatTarget, text: string): string {
  const escapedText = escapeAppleScriptString(text);

  if (target.kind === 'chat-guid') {
    const escapedChatId = escapeAppleScriptString(target.value);
    return `
      tell application "Messages"
        set targetChat to chat id "${escapedChatId}"
        send "${escapedText}" to targetChat
      end tell
    `;
  }

  const escapedHandle = escapeAppleScriptString(target.value);
  return `
    tell application "Messages"
      set targetService to 1st service whose service type = iMessage
      set targetBuddy to buddy "${escapedHandle}" of targetService
      send "${escapedText}" to targetBuddy
    end tell
  `;
}

export async function sendTextViaAppleScript(
  target: IMessageChatTarget,
  text: string,
): Promise<void> {
  const script = scriptForTarget(target, text);
  await execFileAsync('osascript', ['-e', script]);
}
