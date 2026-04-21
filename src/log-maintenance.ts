import fs from 'fs';
import path from 'path';

import { GROUPS_DIR, LOGS_DIR } from './config.js';

const MB = 1024 * 1024;

export const LOG_MAINTENANCE_INTERVAL_MS = 10 * 60 * 1000;

export const NANOCLAW_LOG_MAX_BYTES = 16 * MB;
export const NANOCLAW_LOG_RETAIN_BYTES = 8 * MB;
export const NANOCLAW_ERROR_LOG_MAX_BYTES = 4 * MB;
export const NANOCLAW_ERROR_LOG_RETAIN_BYTES = 2 * MB;

export const CONFIG_CHANGE_LOG_MAX_BYTES = 4 * MB;
export const CONFIG_CHANGE_LOG_MAX_ARCHIVES = 10;

export const WEBSOCKET_EVENT_LOG_MAX_BYTES = 10 * MB;
export const WEBSOCKET_EVENT_LOG_MAX_ARCHIVES = 8;

export const WORKER_LOG_MAX_FILES = 300;
export const WORKER_LOG_MAX_TOTAL_BYTES = 200 * MB;

const WORKER_LOG_FILE_PATTERN = /^worker-.*\.log$/;

interface WorkerLogEntry {
  filePath: string;
  fileName: string;
  size: number;
  mtimeMs: number;
}

function readTailBytes(filePath: string, maxBytes: number): Buffer {
  const stat = fs.statSync(filePath);
  if (stat.size <= maxBytes) {
    return fs.readFileSync(filePath);
  }

  const fd = fs.openSync(filePath, 'r');
  try {
    const tailSize = Math.max(0, Math.min(maxBytes, stat.size));
    const buffer = Buffer.allocUnsafe(tailSize);
    const offset = stat.size - tailSize;
    fs.readSync(fd, buffer, 0, tailSize, offset);
    return buffer;
  } finally {
    fs.closeSync(fd);
  }
}

function listWorkerLogs(logsDir: string): WorkerLogEntry[] {
  if (!fs.existsSync(logsDir)) return [];

  return fs
    .readdirSync(logsDir, { withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && WORKER_LOG_FILE_PATTERN.test(entry.name),
    )
    .map((entry) => {
      const filePath = path.join(logsDir, entry.name);
      const stat = fs.statSync(filePath);
      return {
        filePath,
        fileName: entry.name,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      };
    })
    .sort((a, b) => {
      if (a.mtimeMs !== b.mtimeMs) return a.mtimeMs - b.mtimeMs;
      return a.fileName.localeCompare(b.fileName);
    });
}

function listGroupPaths(): string[] {
  if (!fs.existsSync(GROUPS_DIR)) return [];
  return fs
    .readdirSync(GROUPS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(GROUPS_DIR, entry.name));
}

export function compactLaunchdLogInPlace(
  filePath: string,
  maxBytes: number,
  retainBytes: number,
): boolean {
  if (!fs.existsSync(filePath)) return false;
  const stat = fs.statSync(filePath);
  if (stat.size <= maxBytes) return false;

  const nextSize = Math.max(1, Math.min(retainBytes, maxBytes));
  const tail = readTailBytes(filePath, nextSize);
  fs.writeFileSync(filePath, tail);
  return true;
}

export function rotateManagedAppendLog(
  filePath: string,
  maxBytes: number,
  maxArchives: number,
): boolean {
  if (!fs.existsSync(filePath)) return false;
  const stat = fs.statSync(filePath);
  if (stat.size <= maxBytes) return false;

  const archiveCount = Math.max(0, maxArchives);
  if (archiveCount > 0) {
    const oldestArchive = `${filePath}.${archiveCount}`;
    if (fs.existsSync(oldestArchive)) {
      fs.unlinkSync(oldestArchive);
    }

    for (let index = archiveCount - 1; index >= 1; index--) {
      const source = `${filePath}.${index}`;
      const target = `${filePath}.${index + 1}`;
      if (!fs.existsSync(source)) continue;
      fs.renameSync(source, target);
    }

    fs.renameSync(filePath, `${filePath}.1`);
    return true;
  }

  fs.writeFileSync(filePath, '');
  return true;
}

export function pruneWorkerLogsForGroup(
  groupPath: string,
  maxFiles = WORKER_LOG_MAX_FILES,
  maxTotalBytes = WORKER_LOG_MAX_TOTAL_BYTES,
): { removedFiles: number; removedBytes: number } {
  const logsDir = path.join(groupPath, 'logs');
  const entries = listWorkerLogs(logsDir);
  if (entries.length === 0) {
    return { removedFiles: 0, removedBytes: 0 };
  }

  let removedFiles = 0;
  let removedBytes = 0;
  let totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  let currentFiles = entries.length;

  for (const entry of entries) {
    const overFileLimit = currentFiles > maxFiles;
    const overSizeLimit = totalBytes > maxTotalBytes;
    if (!overFileLimit && !overSizeLimit) break;

    fs.unlinkSync(entry.filePath);
    removedFiles += 1;
    removedBytes += entry.size;
    totalBytes -= entry.size;
    currentFiles -= 1;
  }

  return {
    removedFiles,
    removedBytes,
  };
}

export function maintainHostLaunchdLogs(): void {
  compactLaunchdLogInPlace(
    path.join(LOGS_DIR, 'nanoclaw.log'),
    NANOCLAW_LOG_MAX_BYTES,
    NANOCLAW_LOG_RETAIN_BYTES,
  );
  compactLaunchdLogInPlace(
    path.join(LOGS_DIR, 'nanoclaw.error.log'),
    NANOCLAW_ERROR_LOG_MAX_BYTES,
    NANOCLAW_ERROR_LOG_RETAIN_BYTES,
  );
}

export function pruneAllWorkerLogs(): void {
  for (const groupPath of listGroupPaths()) {
    pruneWorkerLogsForGroup(groupPath);
  }
}
