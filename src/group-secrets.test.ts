import fs from 'fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { readEnvFileMock, testGroupSecretsPath } = vi.hoisted(() => ({
  readEnvFileMock: vi.fn(),
  testGroupSecretsPath: '/tmp/nanoclaw-group-secrets.test.json',
}));

vi.mock('./config.js', () => ({
  GROUP_SECRETS_PATH: testGroupSecretsPath,
}));

vi.mock('./env.js', () => ({
  readEnvFile: readEnvFileMock,
}));

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  loadGroupSecretsConfig,
  resolveGroupWorkerEnv,
} from './group-secrets.js';

describe('group secrets config', () => {
  beforeEach(() => {
    readEnvFileMock.mockReset();
    try {
      fs.unlinkSync(testGroupSecretsPath);
    } catch {
      // ignore missing file
    }
  });

  afterEach(() => {
    try {
      fs.unlinkSync(testGroupSecretsPath);
    } catch {
      // ignore missing file
    }
  });

  it('returns an empty config when the file does not exist', () => {
    expect(loadGroupSecretsConfig()).toEqual({
      version: 1,
      groups: {},
    });
  });

  it('loads a valid group secrets config file', () => {
    fs.writeFileSync(
      testGroupSecretsPath,
      JSON.stringify({
        version: 1,
        groups: {
          example_group: {
            env: {
              HOME_ASSISTANT_URL: 'https://ha.example',
            },
          },
        },
      }),
    );

    expect(loadGroupSecretsConfig()).toEqual({
      version: 1,
      groups: {
        example_group: {
          env: {
            HOME_ASSISTANT_URL: 'https://ha.example',
          },
        },
      },
    });
  });

  it('returns an empty config for invalid JSON', () => {
    fs.writeFileSync(testGroupSecretsPath, '{invalid');

    expect(loadGroupSecretsConfig()).toEqual({
      version: 1,
      groups: {},
    });
  });

  it('returns an empty config for invalid schema', () => {
    fs.writeFileSync(
      testGroupSecretsPath,
      JSON.stringify({
        version: 2,
        groups: {},
      }),
    );

    expect(loadGroupSecretsConfig()).toEqual({
      version: 1,
      groups: {},
    });
  });

  it('resolves group worker env with group overrides over project .env', () => {
    fs.writeFileSync(
      testGroupSecretsPath,
      JSON.stringify({
        version: 1,
        groups: {
          example_group: {
            env: {
              HOME_ASSISTANT_URL: 'https://override.example',
              HASS_ACCESS_TOKEN: '',
            },
          },
        },
      }),
    );
    readEnvFileMock.mockReturnValue({
      HOME_ASSISTANT_URL: 'https://fallback.example',
      HASS_ACCESS_TOKEN: 'fallback-token',
    });

    expect(resolveGroupWorkerEnv('example_group')).toEqual({
      HOME_ASSISTANT_URL: 'https://override.example',
      HASS_ACCESS_TOKEN: 'fallback-token',
    });
    expect(readEnvFileMock).toHaveBeenCalledWith([
      'HOME_ASSISTANT_URL',
      'HASS_ACCESS_TOKEN',
    ]);
  });

  it('returns an empty worker env when the group is not configured', () => {
    fs.writeFileSync(
      testGroupSecretsPath,
      JSON.stringify({
        version: 1,
        groups: {
          example_group: {
            env: {
              HOME_ASSISTANT_URL: 'https://ha.example',
            },
          },
        },
      }),
    );

    expect(resolveGroupWorkerEnv('telegram_ops')).toEqual({});
    expect(readEnvFileMock).not.toHaveBeenCalled();
  });

  it('treats an empty group env object as no override', () => {
    fs.writeFileSync(
      testGroupSecretsPath,
      JSON.stringify({
        version: 1,
        groups: {
          example_group: {
            env: {},
          },
        },
      }),
    );

    expect(resolveGroupWorkerEnv('example_group')).toEqual({});
    expect(readEnvFileMock).not.toHaveBeenCalled();
  });
});
