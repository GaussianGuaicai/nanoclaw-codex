import { readEnvFile } from '../../env.js';

export type IMessageBackend = 'bluebubbles' | 'smserver';

export interface IMessageBackendConfig {
  backend: IMessageBackend;
  fallbackBackend: IMessageBackend | null;
  account: string;
  allowedHosts: string[];
  allowInsecureHttp: boolean;
  blueBubbles: {
    url: string;
    password: string;
  };
  smserver: {
    url: string;
  };
  riskyMode: {
    enableDirectChatDb: boolean;
    confirmed: boolean;
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
    'NANOCLAW_IMESSAGE_ALLOWED_HOSTS',
    'NANOCLAW_IMESSAGE_ALLOW_INSECURE_HTTP',
    'NANOCLAW_IMESSAGE_ENABLE_DIRECT_CHATDB',
    'NANOCLAW_IMESSAGE_I_UNDERSTAND_CHATDB_RISKS',
  ]);

  const backend = parseBackend(env.NANOCLAW_IMESSAGE_BACKEND, 'bluebubbles');
  const fallbackBackend = parseBackend(
    env.NANOCLAW_IMESSAGE_FALLBACK_BACKEND,
    null,
  );

  const allowedHosts = parseAllowedHosts(env.NANOCLAW_IMESSAGE_ALLOWED_HOSTS);
  const allowInsecureHttp = parseBool(
    env.NANOCLAW_IMESSAGE_ALLOW_INSECURE_HTTP,
  );

  return {
    backend: backend || 'bluebubbles',
    fallbackBackend:
      fallbackBackend && fallbackBackend !== backend ? fallbackBackend : null,
    account: env.IMESSAGE_ACCOUNT || '',
    allowedHosts,
    allowInsecureHttp,
    blueBubbles: {
      url: validateBackendUrl(
        env.BLUEBUBBLES_URL || '',
        allowedHosts,
        allowInsecureHttp,
      ),
      password: env.BLUEBUBBLES_PASSWORD || '',
    },
    smserver: {
      url: validateBackendUrl(
        env.SMSERVER_URL || '',
        allowedHosts,
        allowInsecureHttp,
      ),
    },
    riskyMode: {
      enableDirectChatDb: parseBool(env.NANOCLAW_IMESSAGE_ENABLE_DIRECT_CHATDB),
      confirmed: parseBool(env.NANOCLAW_IMESSAGE_I_UNDERSTAND_CHATDB_RISKS),
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

function parseBool(value: string | undefined): boolean {
  return value === 'true';
}

function parseAllowedHosts(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function validateBackendUrl(
  value: string,
  allowedHosts: string[],
  allowInsecureHttp: boolean,
): string {
  if (!value) return '';

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return '';
  }

  const host = parsed.hostname.toLowerCase();
  const protocol = parsed.protocol.toLowerCase();

  const localHost = isLocalHost(host);
  const explicitlyAllowed = allowedHosts.includes(host);

  if (
    protocol !== 'https:' &&
    !(localHost || (allowInsecureHttp && explicitlyAllowed))
  ) {
    return '';
  }

  if (!localHost && !explicitlyAllowed && !isHttps(protocol)) {
    return '';
  }

  if (!localHost && !explicitlyAllowed && isHttps(protocol)) {
    return `${parsed.origin}${parsed.pathname.replace(/\/$/, '')}`;
  }

  return `${parsed.origin}${parsed.pathname.replace(/\/$/, '')}`;
}

function isHttps(protocol: string): boolean {
  return protocol === 'https:';
}

function isLocalHost(host: string): boolean {
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.startsWith('10.') ||
    host.startsWith('192.168.') ||
    is172Private(host)
  );
}

function is172Private(host: string): boolean {
  const match = host.match(/^172\.(\d{1,3})\./);
  if (!match) return false;
  const secondOctet = Number(match[1]);
  return secondOctet >= 16 && secondOctet <= 31;
}
