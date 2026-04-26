import fs from 'fs';
import path from 'path';

import {
  CODEX_AUTH_AUTOREPAIR,
  CODEX_AUTH_SOURCE_DIR,
  DATA_DIR,
} from './config.js';
import { logger } from './logger.js';

const STATE_FILENAME = 'state.json';
const CREDENTIALS_DIRNAME = 'credentials';
const AUTH_JSON = 'auth.json';

export type ContainerFailureKind =
  | 'auth_failure'
  | 'timeout'
  | 'spawn_error'
  | 'output_parse_error'
  | 'worker_error';

interface AuthFailureState {
  at: string;
  groupFolder: string;
  reason: string;
}

interface CodexAuthState {
  version: 1;
  sourceGroupFolder?: string;
  initializedAt?: string;
  lastSyncedGroupFolder?: string;
  lastSyncAt?: string;
  lastPromotedGroupFolder?: string;
  lastPromotedAt?: string;
  lastFailure?: AuthFailureState;
}

interface EnsureGlobalInitOptions {
  preferredGroupFolder?: string;
  skipGroupFolders?: string[];
}

class AsyncGate {
  private tail = Promise.resolve();

  async acquire(): Promise<() => void> {
    let releaseInner!: () => void;
    const hold = new Promise<void>((resolve) => {
      releaseInner = resolve;
    });
    const previous = this.tail;
    this.tail = this.tail.then(() => hold);
    await previous;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseInner();
    };
  }
}

export function classifyFailureKind(
  raw: string | undefined,
): ContainerFailureKind {
  if (!raw) return 'worker_error';

  const text = raw.toLowerCase();
  if (
    text.includes('refresh_token_reused') ||
    text.includes('provided authentication token is expired') ||
    text.includes('could not be refreshed') ||
    text.includes('failed to refresh token')
  ) {
    return 'auth_failure';
  }
  if (text.includes('timed out')) return 'timeout';
  if (text.includes('spawn error')) return 'spawn_error';
  if (text.includes('failed to parse worker output'))
    return 'output_parse_error';
  return 'worker_error';
}

function nowIso(): string {
  return new Date().toISOString();
}

export class CodexAuthManager {
  private readonly enabled: boolean;
  private readonly sourceDir: string;
  private readonly credentialsDir: string;
  private readonly statePath: string;
  private readonly startupGate = new AsyncGate();

  constructor(options?: { sourceDir?: string; enabled?: boolean }) {
    this.sourceDir = options?.sourceDir || CODEX_AUTH_SOURCE_DIR;
    this.credentialsDir = path.join(this.sourceDir, CREDENTIALS_DIRNAME);
    this.statePath = path.join(this.sourceDir, STATE_FILENAME);
    this.enabled = options?.enabled ?? CODEX_AUTH_AUTOREPAIR;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async enterStartupGate(groupFolder: string): Promise<() => void> {
    if (!this.enabled) return () => {};
    const release = await this.startupGate.acquire();
    logger.debug({ groupFolder }, 'auth-manager: startup gate acquired');
    return () => {
      release();
      logger.debug({ groupFolder }, 'auth-manager: startup gate released');
    };
  }

  syncGlobalToGroup(groupFolder: string): boolean {
    if (!this.enabled) return false;

    if (!this.ensureGlobalInitialized({ preferredGroupFolder: groupFolder })) {
      return false;
    }

    const groupHome = this.groupCodexHome(groupFolder);
    this.copyDirAtomic(this.credentialsDir, groupHome);
    this.writeState({
      lastSyncedGroupFolder: groupFolder,
      lastSyncAt: nowIso(),
    });
    logger.info({ groupFolder }, 'auth-manager: synced global credentials');
    return true;
  }

  promoteGroupToGlobalIfNewer(groupFolder: string): boolean {
    if (!this.enabled) return false;

    const groupHome = this.groupCodexHome(groupFolder);
    if (!this.isCodexHomeUsable(groupHome)) return false;

    const groupAuth = path.join(groupHome, AUTH_JSON);
    const sourceAuth = path.join(this.credentialsDir, AUTH_JSON);
    const shouldPromote =
      !this.isCodexHomeUsable(this.credentialsDir) ||
      fs.statSync(groupAuth).mtimeMs > fs.statSync(sourceAuth).mtimeMs;

    if (!shouldPromote) return false;

    this.copyDirAtomic(groupHome, this.credentialsDir);
    this.writeState({
      sourceGroupFolder: groupFolder,
      initializedAt: nowIso(),
      lastPromotedGroupFolder: groupFolder,
      lastPromotedAt: nowIso(),
    });
    logger.info({ groupFolder }, 'auth-manager: promoted group credentials');
    return true;
  }

  attemptAutoRepair(groupFolder: string, reason: string): boolean {
    if (!this.enabled) return false;
    this.recordAuthFailure(groupFolder, reason);

    if (!this.ensureGlobalInitialized({ skipGroupFolders: [groupFolder] })) {
      logger.warn(
        { groupFolder },
        'auth-manager: no global credentials available for auto-repair',
      );
      return false;
    }

    try {
      const groupHome = this.groupCodexHome(groupFolder);
      const sourceAuthPath = path.join(this.credentialsDir, AUTH_JSON);
      const groupAuthPath = path.join(groupHome, AUTH_JSON);
      const sourceMtimeMs = fs.statSync(sourceAuthPath).mtimeMs;
      const groupMtimeMs = fs.existsSync(groupAuthPath)
        ? fs.statSync(groupAuthPath).mtimeMs
        : Number.NEGATIVE_INFINITY;

      // Prevent tight loops when global credentials did not actually advance.
      if (sourceMtimeMs <= groupMtimeMs) {
        logger.warn(
          { groupFolder },
          'auth-manager: auto-repair skipped because global credentials are not newer',
        );
        return false;
      }

      this.copyDirAtomic(this.credentialsDir, groupHome);
      this.writeState({
        lastSyncedGroupFolder: groupFolder,
        lastSyncAt: nowIso(),
      });
      logger.info({ groupFolder }, 'auth-manager: auto-repair succeeded');
      return true;
    } catch (err) {
      logger.warn(
        { groupFolder, err },
        'auth-manager: auto-repair failed while syncing credentials',
      );
      return false;
    }
  }

  recordAuthFailure(groupFolder: string, reason: string): void {
    if (!this.enabled) return;
    this.writeState({
      lastFailure: {
        at: nowIso(),
        groupFolder,
        reason,
      },
    });
    logger.warn({ groupFolder }, 'auth-manager: recorded auth failure');
  }

  private ensureGlobalInitialized(
    options: EnsureGlobalInitOptions = {},
  ): boolean {
    if (this.isCodexHomeUsable(this.credentialsDir)) return true;

    const skipSet = new Set(options.skipGroupFolders || []);
    const candidates = this.discoverGroupCandidates(
      options.preferredGroupFolder,
    );
    const source = candidates.find(
      (candidate) =>
        !skipSet.has(candidate.groupFolder) &&
        this.isCodexHomeUsable(candidate.path),
    );
    if (!source) return false;

    this.copyDirAtomic(source.path, this.credentialsDir);
    this.writeState({
      sourceGroupFolder: source.groupFolder,
      initializedAt: nowIso(),
    });
    logger.info(
      { sourceGroupFolder: source.groupFolder },
      'auth-manager: initialized global credentials from group',
    );
    return true;
  }

  private discoverGroupCandidates(
    preferredGroupFolder?: string,
  ): Array<{ groupFolder: string; path: string }> {
    const candidates: Array<{ groupFolder: string; path: string }> = [];
    const pushCandidate = (groupFolder: string) => {
      if (
        candidates.some((candidate) => candidate.groupFolder === groupFolder)
      ) {
        return;
      }
      candidates.push({
        groupFolder,
        path: this.groupCodexHome(groupFolder),
      });
    };

    if (preferredGroupFolder) {
      pushCandidate(preferredGroupFolder);
    }

    const sessionsRoot = path.join(DATA_DIR, 'sessions');
    if (!fs.existsSync(sessionsRoot)) return candidates;

    for (const entry of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      pushCandidate(entry.name);
    }
    return candidates;
  }

  private isCodexHomeUsable(homeDir: string): boolean {
    const authPath = path.join(homeDir, AUTH_JSON);
    if (!fs.existsSync(authPath)) return false;
    try {
      const raw = fs.readFileSync(authPath, 'utf-8').trim();
      if (!raw) return false;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return typeof parsed === 'object' && parsed !== null;
    } catch {
      return false;
    }
  }

  private groupCodexHome(groupFolder: string): string {
    return path.join(DATA_DIR, 'sessions', groupFolder, '.codex');
  }

  private copyDirAtomic(sourceDir: string, targetDir: string): void {
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    const tempDir = `${targetDir}.tmp-${process.pid}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;

    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.cpSync(sourceDir, tempDir, {
      recursive: true,
      preserveTimestamps: true,
    });
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.renameSync(tempDir, targetDir);
  }

  private readState(): CodexAuthState {
    if (!fs.existsSync(this.statePath)) {
      return { version: 1 };
    }
    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.statePath, 'utf-8'),
      ) as CodexAuthState;
      if (parsed.version !== 1) {
        return { version: 1 };
      }
      return parsed;
    } catch {
      return { version: 1 };
    }
  }

  private writeState(patch: Partial<CodexAuthState>): void {
    fs.mkdirSync(this.sourceDir, { recursive: true });
    const current = this.readState();
    const next: CodexAuthState = {
      ...current,
      ...patch,
      version: 1,
    };
    fs.writeFileSync(this.statePath, JSON.stringify(next, null, 2));
  }
}

export const codexAuthManager = new CodexAuthManager();
