/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

type ContainerRuntime = 'docker' | 'container';

function binaryExists(bin: string): boolean {
  const pathValue = process.env.PATH;
  if (!pathValue) return false;

  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      // Continue searching PATH.
    }
  }

  return false;
}

function detectContainerRuntime(): ContainerRuntime {
  const override = process.env.NANOCLAW_CONTAINER_RUNTIME?.trim();
  if (override === 'docker' || override === 'container') {
    return override;
  }

  if (binaryExists('docker')) return 'docker';
  if (binaryExists('container')) return 'container';
  return 'docker';
}

/** The active container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = detectContainerRuntime();

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Returns the shell command to stop a container by name. */
export function stopContainer(name: string): string {
  return `${CONTAINER_RUNTIME_BIN} stop ${name}`;
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    if (CONTAINER_RUNTIME_BIN === 'docker') {
      execSync('docker info', { stdio: 'pipe', timeout: 10000 });
    } else {
      execSync('container system status', { stdio: 'pipe', timeout: 10000 });
    }
    logger.debug('Container runtime already running');
  } catch (err) {
    if (CONTAINER_RUNTIME_BIN === 'container') {
      logger.warn(
        { err },
        'Apple Container service is not running, attempting to start it',
      );
      try {
        execSync('container system start', { stdio: 'pipe', timeout: 30000 });
        execSync('container system status', { stdio: 'pipe', timeout: 10000 });
        logger.info('Apple Container service started');
        return;
      } catch (startErr) {
        logger.error(
          { err: startErr },
          'Failed to start Apple Container service',
        );
      }
    } else {
      logger.error({ err }, 'Failed to reach container runtime');
    }

    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: Container runtime failed to start                      ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Agents cannot run without a container runtime. To fix:        ║',
    );
    console.error(
      `║  1. Ensure ${CONTAINER_RUNTIME_BIN} is installed and running${CONTAINER_RUNTIME_BIN === 'docker' ? ' '.repeat(22) : ' '.repeat(19)}║`,
    );
    console.error(
      `║  2. Run: ${CONTAINER_RUNTIME_BIN === 'docker' ? 'docker info' : 'container system status'}${CONTAINER_RUNTIME_BIN === 'docker' ? ' '.repeat(43) : ' '.repeat(28)}║`,
    );
    console.error(
      '║  3. Restart NanoClaw                                           ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Container runtime is required but failed to start');
  }
}

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    const output =
      CONTAINER_RUNTIME_BIN === 'docker'
        ? execSync(`docker ps --filter name=nanoclaw- --format '{{.Names}}'`, {
            stdio: ['pipe', 'pipe', 'pipe'],
            encoding: 'utf-8',
          })
        : execSync('container ls --format json', {
            stdio: ['pipe', 'pipe', 'pipe'],
            encoding: 'utf-8',
          });
    const orphans =
      CONTAINER_RUNTIME_BIN === 'docker'
        ? output.trim().split('\n').filter(Boolean)
        : JSON.parse(output || '[]')
            .map((container: { name?: string; id?: string }) =>
              container.name || container.id || '',
            )
            .filter((name: string) => name.startsWith('nanoclaw-'));
    for (const name of orphans) {
      try {
        execSync(stopContainer(name), { stdio: 'pipe' });
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
