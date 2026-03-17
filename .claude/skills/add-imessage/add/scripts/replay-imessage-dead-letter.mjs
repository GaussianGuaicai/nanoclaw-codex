#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const DEAD_LETTER_FILE = path.join(
  process.cwd(),
  'logs',
  'imessage-dead-letter.jsonl',
);

function readEnvFile(keys) {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return {};
  const wanted = new Set(keys);
  const out = {};
  const content = fs.readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    if (!wanted.has(k)) continue;
    out[k] = t
      .slice(i + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '');
  }
  return out;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const dryRun = !args.has('--execute');

  if (!fs.existsSync(DEAD_LETTER_FILE)) {
    console.log('No dead-letter file found:', DEAD_LETTER_FILE);
    return;
  }

  const env = readEnvFile([
    'NANOCLAW_IMESSAGE_BACKEND',
    'BLUEBUBBLES_URL',
    'BLUEBUBBLES_PASSWORD',
  ]);

  if ((env.NANOCLAW_IMESSAGE_BACKEND || 'bluebubbles') !== 'bluebubbles') {
    throw new Error(
      'Replay script currently supports bluebubbles backend only',
    );
  }
  if (!env.BLUEBUBBLES_URL || !env.BLUEBUBBLES_PASSWORD) {
    throw new Error('Missing BLUEBUBBLES_URL/BLUEBUBBLES_PASSWORD in .env');
  }

  const lines = fs
    .readFileSync(DEAD_LETTER_FILE, 'utf-8')
    .split('\n')
    .map((v) => v.trim())
    .filter(Boolean);

  console.log(`Loaded ${lines.length} dead-letter entries.`);
  if (dryRun) {
    console.log('Dry run mode. Use --execute to replay entries.');
    return;
  }

  for (const line of lines) {
    const row = JSON.parse(line);
    const payload = {
      chatGuid: row.chatId,
      message: row.text,
      method: 'apple-script',
    };

    const res = await fetch(
      `${env.BLUEBUBBLES_URL.replace(/\/$/, '')}/api/v1/message/text`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          password: env.BLUEBUBBLES_PASSWORD,
        },
        body: JSON.stringify(payload),
      },
    );

    if (!res.ok) {
      console.error('Replay failed for', row.chatId, 'status=', res.status);
      continue;
    }

    console.log('Replayed:', row.chatId);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
