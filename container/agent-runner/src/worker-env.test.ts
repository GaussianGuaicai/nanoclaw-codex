import { describe, expect, it } from 'vitest';

import { buildWorkerEnvironments } from './worker-env.js';

describe('buildWorkerEnvironments', () => {
  it('keeps sdk secrets out of the worker process env but exposes worker env vars', () => {
    const { sdkEnv, workerProcessEnv } = buildWorkerEnvironments(
      {
        prompt: 'hello',
        groupFolder: 'example_group',
        chatJid: 'slack:C123',
        isMain: false,
        sdkSecrets: {
          OPENAI_API_KEY: 'sdk-secret',
        },
        workerEnv: {
          HOME_ASSISTANT_URL: 'https://ha.example',
          HASS_ACCESS_TOKEN: 'worker-secret',
        },
      },
      {},
    );

    expect(sdkEnv).toMatchObject({
      OPENAI_API_KEY: 'sdk-secret',
      HOME_ASSISTANT_URL: 'https://ha.example',
      HASS_ACCESS_TOKEN: 'worker-secret',
    });
    expect(workerProcessEnv).toEqual({
      HOME_ASSISTANT_URL: 'https://ha.example',
      HASS_ACCESS_TOKEN: 'worker-secret',
    });
    expect(workerProcessEnv.OPENAI_API_KEY).toBeUndefined();
  });
});
