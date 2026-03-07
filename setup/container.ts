/**
 * Step: worker/container — Build the local agent worker and verify the build artifact.
 * `container` is kept as a setup-step alias for compatibility.
 */
import { execSync } from 'child_process';
import path from 'path';

import { logger } from '../src/logger.js';
import { emitStatus } from './status.js';

export async function run(args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const workerEntry = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'dist',
    'index.js',
  );

  // Build
  let buildOk = false;
  logger.info({ args }, 'Building local worker');
  try {
    execSync('npm run build', {
      cwd: path.join(projectRoot, 'container', 'agent-runner'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    buildOk = true;
    logger.info('Worker build succeeded');
  } catch (err) {
    logger.error({ err }, 'Worker build failed');
  }

  // Test
  let testOk = false;
  if (buildOk) {
    logger.info('Testing worker artifact');
    try {
      testOk = !!execSync(`test -f "${workerEntry}" && printf ok`, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).includes('ok');
      logger.info({ testOk }, 'Worker artifact test result');
    } catch (err) {
      logger.error({ err }, 'Worker artifact test failed');
    }
  }

  const status = buildOk && testOk ? 'success' : 'failed';

  emitStatus('SETUP_WORKER', {
    RUNTIME: 'local-codex-worker',
    ENTRYPOINT: workerEntry,
    BUILD_OK: buildOk,
    TEST_OK: testOk,
    STATUS: status,
    LOG: 'logs/setup.log',
  });

  emitStatus('SETUP_CONTAINER', {
    RUNTIME: 'deprecated-local-worker',
    IMAGE: 'none',
    BUILD_OK: buildOk,
    TEST_OK: testOk,
    STATUS: status,
    LOG: 'logs/setup.log',
  });

  if (status === 'failed') process.exit(1);
}
