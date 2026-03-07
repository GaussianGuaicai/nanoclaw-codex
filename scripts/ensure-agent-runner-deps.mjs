import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const projectRoot = process.cwd();
const workerRoot = path.join(projectRoot, 'container', 'agent-runner');
const requiredPaths = [
  path.join(workerRoot, 'node_modules', '.bin', 'tsc'),
  path.join(workerRoot, 'node_modules', '@openai', 'codex-sdk', 'package.json'),
  path.join(
    workerRoot,
    'node_modules',
    '@modelcontextprotocol',
    'sdk',
    'package.json',
  ),
];

if (requiredPaths.every((candidate) => fs.existsSync(candidate))) {
  process.exit(0);
}

const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const installMode = fs.existsSync(path.join(workerRoot, 'package-lock.json'))
  ? 'ci'
  : 'install';
const result = spawnSync(npmBin, [installMode], {
  cwd: workerRoot,
  stdio: 'inherit',
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
