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
  });

  it('includes the required channel/backend/local files', () => {
    const requiredFiles = [
      'add/src/channels/imessage/index.ts',
      'add/src/channels/imessage/channel.ts',
      'add/src/channels/imessage/backend.ts',
      'add/src/channels/imessage/backends/local-macos.ts',
      'add/src/channels/imessage/backends/bluebubbles.ts',
      'add/src/channels/imessage/local/chat-db.ts',
      'add/src/channels/imessage/local/applescript.ts',
      'add/src/channels/imessage/local/normalize.ts',
      'add/src/channels/imessage/local/checkpoint.ts',
      'add/src/channels/imessage/channel.test.ts',
      'add/src/channels/imessage/local/normalize.test.ts',
      'add/src/channels/imessage/local/checkpoint.test.ts',
      'add/src/channels/imessage/backends/local-macos.test.ts',
    ];

    for (const file of requiredFiles) {
      expect(fs.existsSync(path.join(skillDir, file))).toBe(true);
    }
  });

  it('uses sqlite-compatible participant aggregation SQL', () => {
    const chatDbPath = path.join(
      skillDir,
      'add',
      'src',
      'channels',
      'imessage',
      'local',
      'chat-db.ts',
    );
    const content = fs.readFileSync(chatDbPath, 'utf-8');

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

  it('modifies the channel barrel by importing imessage/index.js', () => {
    const indexPath = path.join(
      skillDir,
      'modify',
      'src',
      'channels',
      'index.ts',
    );
    const content = fs.readFileSync(indexPath, 'utf-8');

    expect(content).toContain("import './imessage/index.js';");
  });

  it('documents backend seam and macOS-only phase 1 support', () => {
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    expect(skillMd).toContain('local-macos');
    expect(skillMd).toContain('bluebubbles');
    expect(skillMd).toContain('imessage:<stable-chat-id>');

    const setupMd = fs.readFileSync(
      path.join(skillDir, 'IMESSAGE_SETUP.md'),
      'utf-8',
    );
    expect(setupMd).toContain('macOS');
    expect(setupMd).toContain('Messages.app');
  });
});
