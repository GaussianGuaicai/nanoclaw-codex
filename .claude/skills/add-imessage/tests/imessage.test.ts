import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

describe('add-imessage skill package', () => {
  const skillDir = path.resolve(__dirname, '..');

  it('has a valid manifest with env additions', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const content = fs.readFileSync(manifestPath, 'utf-8');
    expect(content).toContain('skill: imessage');
    expect(content).toContain('IMESSAGE_ENABLED');
    expect(content).toContain('IMESSAGE_BACKEND');
    expect(content).toContain('IMESSAGE_ALLOWED_CONTACTS');
  });

  it('includes the required single-file channel implementation', () => {
    const requiredFiles = [
      'add/src/channels/imessage.ts',
      'add/src/channels/imessage.test.ts',
    ];

    for (const file of requiredFiles) {
      expect(fs.existsSync(path.join(skillDir, file))).toBe(true);
    }
  });

  it('uses sqlite-compatible participant aggregation SQL', () => {
    const channelPath = path.join(
      skillDir,
      'add',
      'src',
      'channels',
      'imessage.ts',
    );
    const content = fs.readFileSync(channelPath, 'utf-8');

    expect(content).toContain(
      'REPLACE(GROUP_CONCAT(DISTINCT handle.id), \',\', char(31)) AS participants',
    );
    expect(content).toContain(
      'REPLACE(GROUP_CONCAT(DISTINCT participant.id), \',\', char(31)) AS participants',
    );
    expect(content).not.toContain(
      'GROUP_CONCAT(DISTINCT handle.id, char(31)) AS participants',
    );
    expect(content).not.toContain(
      'GROUP_CONCAT(DISTINCT participant.id, char(31)) AS participants',
    );
  });

  it('modifies the channel barrel by importing imessage.js', () => {
    const indexPath = path.join(
      skillDir,
      'modify',
      'src',
      'channels',
      'index.ts',
    );
    const content = fs.readFileSync(indexPath, 'utf-8');

    expect(content).toContain("import './imessage.js';");
  });

  it('documents backend seam and macOS-only phase 1 support', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    expect(skillMd).toContain('local-macos');
    expect(skillMd).toContain('bluebubbles');
    expect(skillMd).toContain('imessage:<stable-chat-id>');
    expect(skillMd).toContain('groups.<folder>.env');

    const setupMd = fs.readFileSync(
      path.join(skillDir, 'IMESSAGE_SETUP.md'),
      'utf-8',
    );
    expect(setupMd).toContain('macOS');
    expect(setupMd).toContain('Messages.app');
    expect(setupMd).toContain('groups.<folder>.env');
    expect(setupMd).toContain('workerEnv');
  });
});
