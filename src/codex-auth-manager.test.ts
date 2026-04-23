import fs from 'fs';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const TEST_DATA_DIR = '/tmp/nanoclaw-auth-manager-tests';

vi.mock('./config.js', () => ({
  CODEX_AUTH_AUTOREPAIR: true,
  CODEX_AUTH_SOURCE_DIR: '/tmp/nanoclaw-auth-manager-tests/default-source',
  DATA_DIR: '/tmp/nanoclaw-auth-manager-tests',
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { CodexAuthManager } from './codex-auth-manager.js';

function writeAuthFile(codexHome: string, accessToken: string): void {
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(
    path.join(codexHome, 'auth.json'),
    JSON.stringify(
      {
        tokens: {
          access_token: accessToken,
        },
      },
      null,
      2,
    ),
  );
}

describe('CodexAuthManager', () => {
  beforeEach(() => {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it('bootstraps from first valid group and syncs global credentials to target group', () => {
    const sourceDir = path.join(TEST_DATA_DIR, 'source-a');
    const sourceGroupHome = path.join(
      TEST_DATA_DIR,
      'sessions',
      'group-a',
      '.codex',
    );
    writeAuthFile(sourceGroupHome, 'token-a');

    const manager = new CodexAuthManager({ sourceDir, enabled: true });
    const synced = manager.syncGlobalToGroup('group-b');

    expect(synced).toBe(true);
    expect(
      fs.existsSync(path.join(sourceDir, 'credentials', 'auth.json')),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(TEST_DATA_DIR, 'sessions', 'group-b', '.codex', 'auth.json'),
      ),
    ).toBe(true);

    const state = JSON.parse(
      fs.readFileSync(path.join(sourceDir, 'state.json'), 'utf-8'),
    ) as Record<string, unknown>;
    expect(state.sourceGroupFolder).toBe('group-a');
    expect(state.lastSyncedGroupFolder).toBe('group-b');
  });

  it('promotes newer group credentials back to global source', () => {
    const sourceDir = path.join(TEST_DATA_DIR, 'source-b');
    const globalHome = path.join(sourceDir, 'credentials');
    const groupHome = path.join(TEST_DATA_DIR, 'sessions', 'group-c', '.codex');
    writeAuthFile(globalHome, 'old-token');
    writeAuthFile(groupHome, 'new-token');

    const globalAuthPath = path.join(globalHome, 'auth.json');
    const groupAuthPath = path.join(groupHome, 'auth.json');
    const older = new Date(Date.now() - 60_000);
    const newer = new Date();
    fs.utimesSync(globalAuthPath, older, older);
    fs.utimesSync(groupAuthPath, newer, newer);

    const manager = new CodexAuthManager({ sourceDir, enabled: true });
    const promoted = manager.promoteGroupToGlobalIfNewer('group-c');

    expect(promoted).toBe(true);
    const globalAuth = JSON.parse(
      fs.readFileSync(globalAuthPath, 'utf-8'),
    ) as Record<string, unknown>;
    expect(globalAuth).toMatchObject({
      tokens: { access_token: 'new-token' },
    });
  });

  it('serializes startup auth gate across groups', async () => {
    const manager = new CodexAuthManager({
      sourceDir: path.join(TEST_DATA_DIR, 'source-c'),
      enabled: true,
    });

    const releaseA = await manager.enterStartupGate('group-a');
    let acquiredB = false;

    const waitForB = manager.enterStartupGate('group-b').then((releaseB) => {
      acquiredB = true;
      return releaseB;
    });

    await Promise.resolve();
    expect(acquiredB).toBe(false);

    releaseA();
    const releaseB = await waitForB;
    expect(acquiredB).toBe(true);

    releaseB();
  });

  it('records auth failure and returns false when autorepair has no credentials', () => {
    const sourceDir = path.join(TEST_DATA_DIR, 'source-d');
    const manager = new CodexAuthManager({ sourceDir, enabled: true });

    const repaired = manager.attemptAutoRepair(
      'missing-group',
      'refresh_token_reused',
    );

    expect(repaired).toBe(false);
    const state = JSON.parse(
      fs.readFileSync(path.join(sourceDir, 'state.json'), 'utf-8'),
    ) as Record<string, any>;
    expect(state.lastFailure?.groupFolder).toBe('missing-group');
    expect(state.lastFailure?.reason).toBe('refresh_token_reused');
  });

  it('skips autorepair when global credentials are not newer than group copy', () => {
    const sourceDir = path.join(TEST_DATA_DIR, 'source-e');
    const globalHome = path.join(sourceDir, 'credentials');
    const groupHome = path.join(TEST_DATA_DIR, 'sessions', 'group-e', '.codex');
    writeAuthFile(globalHome, 'token-global');
    writeAuthFile(groupHome, 'token-group');

    const globalAuthPath = path.join(globalHome, 'auth.json');
    const groupAuthPath = path.join(groupHome, 'auth.json');
    const older = new Date(Date.now() - 60_000);
    const newer = new Date();
    fs.utimesSync(globalAuthPath, older, older);
    fs.utimesSync(groupAuthPath, newer, newer);

    const manager = new CodexAuthManager({ sourceDir, enabled: true });
    const repaired = manager.attemptAutoRepair('group-e', 'refresh_token_reused');

    expect(repaired).toBe(false);
  });
});
