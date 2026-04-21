import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  compactLaunchdLogInPlace,
  pruneWorkerLogsForGroup,
  rotateManagedAppendLog,
} from './log-maintenance.js';

function createTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-log-maint-'));
}

describe('log maintenance', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0, tempRoots.length)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('compacts launchd logs in place and keeps files appendable', () => {
    const root = createTempRoot();
    tempRoots.push(root);

    const logPath = path.join(root, 'nanoclaw.log');
    fs.writeFileSync(logPath, `${'A'.repeat(512)}ENDMARK`);

    const compacted = compactLaunchdLogInPlace(logPath, 256, 128);
    expect(compacted).toBe(true);

    const compactedContent = fs.readFileSync(logPath, 'utf-8');
    expect(compactedContent.length).toBeLessThanOrEqual(128);
    expect(compactedContent.endsWith('ENDMARK')).toBe(true);

    fs.appendFileSync(logPath, '\nNEXT');
    const appended = fs.readFileSync(logPath, 'utf-8');
    expect(appended.endsWith('\nNEXT')).toBe(true);
  });

  it('rotates managed append logs by size and respects archive count', () => {
    const root = createTempRoot();
    tempRoots.push(root);

    const logPath = path.join(root, 'websocket-events-home_assistant.log');

    fs.writeFileSync(logPath, 'A'.repeat(20));
    rotateManagedAppendLog(logPath, 10, 2);
    expect(fs.readFileSync(`${logPath}.1`, 'utf-8')).toBe('A'.repeat(20));
    expect(fs.existsSync(logPath)).toBe(false);

    fs.writeFileSync(logPath, 'B'.repeat(20));
    rotateManagedAppendLog(logPath, 10, 2);
    expect(fs.readFileSync(`${logPath}.1`, 'utf-8')).toBe('B'.repeat(20));
    expect(fs.readFileSync(`${logPath}.2`, 'utf-8')).toBe('A'.repeat(20));

    fs.writeFileSync(logPath, 'C'.repeat(20));
    rotateManagedAppendLog(logPath, 10, 2);
    expect(fs.readFileSync(`${logPath}.1`, 'utf-8')).toBe('C'.repeat(20));
    expect(fs.readFileSync(`${logPath}.2`, 'utf-8')).toBe('B'.repeat(20));
  });

  it('prunes worker logs by oldest-first count and total-size limits', () => {
    const root = createTempRoot();
    tempRoots.push(root);

    const groupPath = path.join(root, 'groups', 'test-group');
    const logsDir = path.join(groupPath, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });

    for (let index = 1; index <= 5; index++) {
      const filePath = path.join(logsDir, `worker-${index}.log`);
      fs.writeFileSync(filePath, `${index}`.repeat(10));
      const timestamp = new Date(2026, 0, 1, 0, 0, index);
      fs.utimesSync(filePath, timestamp, timestamp);
    }
    fs.writeFileSync(path.join(logsDir, 'notes.log'), 'keep');

    const result = pruneWorkerLogsForGroup(groupPath, 3, 25);
    expect(result).toEqual({ removedFiles: 3, removedBytes: 30 });

    expect(fs.existsSync(path.join(logsDir, 'worker-1.log'))).toBe(false);
    expect(fs.existsSync(path.join(logsDir, 'worker-2.log'))).toBe(false);
    expect(fs.existsSync(path.join(logsDir, 'worker-3.log'))).toBe(false);
    expect(fs.existsSync(path.join(logsDir, 'worker-4.log'))).toBe(true);
    expect(fs.existsSync(path.join(logsDir, 'worker-5.log'))).toBe(true);
    expect(fs.existsSync(path.join(logsDir, 'notes.log'))).toBe(true);
  });
});
