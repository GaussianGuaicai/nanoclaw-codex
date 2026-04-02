import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';

const INSTRUCTION_FILENAMES = ['AGENTS.md', 'CLAUDE.md', 'preferences.md'];

export function findInstructionFiles(rootPath: string): string[] {
  const nestedRoot = path.join(rootPath, 'groups', path.basename(rootPath));
  const rootCandidates = INSTRUCTION_FILENAMES.map((filename) =>
    path.join(rootPath, filename),
  );
  const legacyCandidates = INSTRUCTION_FILENAMES.map((filename) => {
    const rootCandidate = path.join(rootPath, filename);
    const legacyCandidate = path.join(nestedRoot, filename);
    if (fs.existsSync(rootCandidate)) {
      return null;
    }
    return legacyCandidate;
  }).filter((candidate): candidate is string => candidate !== null);
  const candidates = [...rootCandidates, ...legacyCandidates];

  const files: string[] = [];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const content = fs.readFileSync(candidate, 'utf-8').trim();
    if (!content) continue;
    files.push(candidate);
  }

  return files;
}

export function dedupeInstructionPaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of paths) {
    const resolved = path.resolve(value);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    result.push(resolved);
  }

  return result;
}

export function listSourceSharedInstructionFiles(
  group: RegisteredGroup,
  isMain: boolean,
): string[] {
  const files: string[] = [];
  const groupPath = resolveGroupFolderPath(group.folder);

  files.push(...findInstructionFiles(groupPath));

  if (isMain) {
    files.push(...findInstructionFiles(process.cwd()));
  }

  const globalDir = path.join(GROUPS_DIR, 'global');
  if (fs.existsSync(globalDir)) {
    files.push(...findInstructionFiles(globalDir));
  }

  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );

    for (const mount of validatedMounts) {
      files.push(...findInstructionFiles(mount.hostPath));
    }
  }

  return dedupeInstructionPaths(files);
}

export function readInstructionFileTexts(paths: string[]): string[] {
  const texts: string[] = [];
  for (const filePath of paths) {
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, 'utf-8').trim();
    if (!content) continue;
    texts.push(content);
  }
  return texts;
}

export function readSharedInstructionTextsForGroup(
  group: RegisteredGroup,
  isMain: boolean,
): string[] {
  return readInstructionFileTexts(
    listSourceSharedInstructionFiles(group, isMain),
  );
}
