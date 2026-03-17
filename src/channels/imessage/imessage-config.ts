import { readEnvFile } from '../../env.js';

export type IMessageBackend = 'bluebubbles' | 'smserver';

export interface IMessageBackendConfig {
  backend: IMessageBackend;
  fallbackBackend: IMessageBackend | null;
  account: string;
  blueBubbles: {
    url: string;
    password: string;
  };
  smserver: {
    url: string;
  };
}

export function loadIMessageConfig(): IMessageBackendConfig {
  const env = readEnvFile([
    'IMESSAGE_ACCOUNT',
    'NANOCLAW_IMESSAGE_BACKEND',
    'NANOCLAW_IMESSAGE_FALLBACK_BACKEND',
    'BLUEBUBBLES_URL',
    'BLUEBUBBLES_PASSWORD',
    'SMSERVER_URL',
  ]);

  const backend =
    parseBackend(
      process.env.NANOCLAW_IMESSAGE_BACKEND || env.NANOCLAW_IMESSAGE_BACKEND,
      'bluebubbles',
    ) || 'bluebubbles';
  const fallbackBackend = parseBackend(
    process.env.NANOCLAW_IMESSAGE_FALLBACK_BACKEND ||
      env.NANOCLAW_IMESSAGE_FALLBACK_BACKEND,
    null,
  );

  return {
    backend,
    fallbackBackend: fallbackBackend === backend ? null : fallbackBackend,
    account: process.env.IMESSAGE_ACCOUNT || env.IMESSAGE_ACCOUNT || '',
    blueBubbles: {
      url: process.env.BLUEBUBBLES_URL || env.BLUEBUBBLES_URL || '',
      password:
        process.env.BLUEBUBBLES_PASSWORD || env.BLUEBUBBLES_PASSWORD || '',
    },
    smserver: {
      url: process.env.SMSERVER_URL || env.SMSERVER_URL || '',
    },
  };
}

function parseBackend(
  value: string | undefined,
  fallback: IMessageBackend | null,
): IMessageBackend | null {
  if (!value) return fallback;
  if (value === 'bluebubbles' || value === 'smserver') return value;
  return fallback;
}
