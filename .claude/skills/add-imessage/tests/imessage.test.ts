import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('imessage skill package', () => {
  const skillDir = path.resolve(__dirname, '..');

  it('has a valid manifest', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const content = fs.readFileSync(manifestPath, 'utf-8');
    expect(content).toContain('skill: imessage');
    expect(content).toContain('version: 1.0.0');
    expect(content).toContain('NANOCLAW_IMESSAGE_BACKEND');
  });

  it('has required add files', () => {
    const channelFile = path.join(skillDir, 'add', 'src', 'channels', 'imessage.ts');
    expect(fs.existsSync(channelFile)).toBe(true);

    const channelContent = fs.readFileSync(channelFile, 'utf-8');
    expect(channelContent).toContain('class IMessageChannel');
    expect(channelContent).toContain('implements Channel');
    expect(channelContent).toContain("registerChannel('imessage'");

    const adapterTypes = path.join(
      skillDir,
      'add',
      'src',
      'channels',
      'imessage',
      'adapters',
      'types.ts',
    );
    expect(fs.existsSync(adapterTypes)).toBe(true);

    const bluebubbles = path.join(
      skillDir,
      'add',
      'src',
      'channels',
      'imessage',
      'adapters',
      'bluebubbles-adapter.ts',
    );
    expect(fs.existsSync(bluebubbles)).toBe(true);
  });

  it('has required modify files', () => {
    const indexFile = path.join(skillDir, 'modify', 'src', 'channels', 'index.ts');
    expect(fs.existsSync(indexFile)).toBe(true);

    const indexContent = fs.readFileSync(indexFile, 'utf-8');
    expect(indexContent).toContain("import './imessage.js'");

    const intentFile = path.join(
      skillDir,
      'modify',
      'src',
      'channels',
      'index.ts.intent.md',
    );
    expect(fs.existsSync(intentFile)).toBe(true);
  });

  it('documents setup and credentials', () => {
    const skillDoc = path.join(skillDir, 'SKILL.md');
    expect(fs.existsSync(skillDoc)).toBe(true);

    const content = fs.readFileSync(skillDoc, 'utf-8');
    expect(content).toContain('IMESSAGE_BACKEND_URL');
    expect(content).toContain('IMESSAGE_AUTH_TOKEN');
    expect(content).toContain('scripts/apply-skill.ts .claude/skills/add-imessage');
  });
});
