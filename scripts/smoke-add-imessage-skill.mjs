import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const skillDir = path.join(root, '.claude', 'skills', 'add-imessage');

function mustExist(relPath) {
  const full = path.join(skillDir, relPath);
  if (!fs.existsSync(full)) {
    throw new Error(`Missing file: ${relPath}`);
  }
  return fs.readFileSync(full, 'utf-8');
}

const manifest = mustExist('manifest.yaml');
if (!manifest.includes('skill: imessage'))
  throw new Error('manifest missing skill: imessage');
if (!manifest.includes('NANOCLAW_IMESSAGE_BACKEND'))
  throw new Error('manifest missing env var');

const skillDoc = mustExist('SKILL.md');
if (!skillDoc.includes('IMESSAGE_BACKEND_URL'))
  throw new Error('SKILL missing IMESSAGE_BACKEND_URL');
if (!skillDoc.includes('IMESSAGE_AUTH_TOKEN'))
  throw new Error('SKILL missing IMESSAGE_AUTH_TOKEN');

const channel = mustExist(path.join('add', 'src', 'channels', 'imessage.ts'));
if (!channel.includes("registerChannel('imessage'"))
  throw new Error('channel missing registerChannel');

mustExist(
  path.join('add', 'src', 'channels', 'imessage', 'imessage-config.ts'),
);
mustExist(
  path.join('add', 'src', 'channels', 'imessage', 'adapters', 'types.ts'),
);
mustExist(
  path.join(
    'add',
    'src',
    'channels',
    'imessage',
    'adapters',
    'bluebubbles-adapter.ts',
  ),
);
mustExist(
  path.join(
    'add',
    'src',
    'channels',
    'imessage',
    'adapters',
    'smserver-adapter.ts',
  ),
);
mustExist(path.join('add', 'scripts', 'replay-imessage-dead-letter.mjs'));

const modifyIndex = mustExist(
  path.join('modify', 'src', 'channels', 'index.ts'),
);
if (!modifyIndex.includes("import './imessage.js'"))
  throw new Error('modify index missing import');
mustExist(path.join('modify', 'src', 'channels', 'index.ts.intent.md'));

console.log('add-imessage skill smoke checks passed');
