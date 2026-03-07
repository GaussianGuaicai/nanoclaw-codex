import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

import { afterEach, describe, expect, it } from 'vitest';

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function loadResolveMcpServerLaunch(): Promise<
  (
    workerDir: string,
    options?: {
      cwd?: string;
      execPath?: string;
    },
  ) => {
    command: string;
    args: string[];
  }
> {
  const moduleUrl = pathToFileURL(
    path.join(process.cwd(), 'container', 'agent-runner', 'src', 'mcp-launch.ts'),
  ).href;
  const mod = (await import(moduleUrl)) as {
    resolveMcpServerLaunch: (
      workerDir: string,
      options?: {
        cwd?: string;
        execPath?: string;
      },
    ) => {
      command: string;
      args: string[];
    };
  };

  return mod.resolveMcpServerLaunch;
}

describe('resolveMcpServerLaunch', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prefers the compiled MCP entrypoint when present', async () => {
    const resolveMcpServerLaunch = await loadResolveMcpServerLaunch();
    const workerDir = createTempDir('nanoclaw-mcp-dist-');
    tempDirs.push(workerDir);
    fs.writeFileSync(path.join(workerDir, 'ipc-mcp-stdio.js'), '');

    const launch = resolveMcpServerLaunch(workerDir, {
      execPath: '/usr/local/bin/node',
    });

    expect(launch).toEqual({
      command: '/usr/local/bin/node',
      args: [path.join(workerDir, 'ipc-mcp-stdio.js')],
    });
  });

  it('falls back to tsx loader in source mode', async () => {
    const resolveMcpServerLaunch = await loadResolveMcpServerLaunch();
    const workerDir = createTempDir('nanoclaw-mcp-src-');
    const projectRoot = createTempDir('nanoclaw-mcp-root-');
    tempDirs.push(workerDir, projectRoot);

    fs.writeFileSync(path.join(workerDir, 'ipc-mcp-stdio.ts'), '');
    fs.mkdirSync(path.join(projectRoot, 'node_modules', 'tsx', 'dist'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs'),
      '',
    );

    const launch = resolveMcpServerLaunch(workerDir, {
      cwd: projectRoot,
      execPath: '/usr/local/bin/node',
    });

    expect(launch).toEqual({
      command: '/usr/local/bin/node',
      args: [
        '--import',
        path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs'),
        path.join(workerDir, 'ipc-mcp-stdio.ts'),
      ],
    });
  });
});
