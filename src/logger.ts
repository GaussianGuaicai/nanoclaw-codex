import pino from 'pino';

const REDACT_PATHS = [
  '*.token',
  '*.tokens',
  '*.password',
  '*.pass',
  '*.secret',
  '*.cookie',
  '*.cookies',
  '*.authorization',
  '*.auth',
  '*.apiKey',
  '*.accessToken',
  '*.refreshToken',
  '*.chatHandle',
  '*.chatId',
  '*.chat_id',
  '*.chat_jid',
  'headers.authorization',
  'headers.cookie',
  'req.headers.authorization',
  'req.headers.cookie',
] as const;

function redactValue(value: unknown): unknown {
  if (typeof value !== 'string') return '[REDACTED]';
  if (value.length <= 8) return '********';
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } },
  redact: {
    paths: [...REDACT_PATHS],
    censor: redactValue,
  },
});

// Route uncaught errors through pino so they get timestamps in stderr
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
