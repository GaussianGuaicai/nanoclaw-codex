import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  getDefaultContextConfig,
  loadContextConfig,
  parseContextConfig,
  resetContextConfigCache,
} from './context-config.js';

describe('context-config', () => {
  afterEach(() => {
    resetContextConfigCache();
  });

  it('returns defaults when config file is missing', () => {
    const config = loadContextConfig(
      '/tmp/definitely-missing-context-config.json',
    );
    expect(config).toEqual(getDefaultContextConfig());
    expect(config.enabled).toBe(false);
  });

  it('merges partial config values with defaults', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-config-'));
    const configPath = path.join(tempDir, 'context-config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        summaryMemory: {
          updateMinTurns: 5,
        },
        sources: {
          isolatedTasks: true,
        },
      }),
    );

    const config = loadContextConfig(configPath);
    expect(config.summaryMemory.updateMinTurns).toBe(5);
    expect(config.summaryMemory.model).toBe('gpt-5.4-mini');
    expect(config.sources.isolatedTasks).toBe(true);
    expect(config.compaction.window.keepRecentTurns).toBe(24);
  });

  it('rejects invalid configuration values', () => {
    expect(() =>
      parseContextConfig({
        compaction: {
          trigger: {
            lastInputTokensGte: 0,
          },
        },
      }),
    ).toThrow();
  });
});
