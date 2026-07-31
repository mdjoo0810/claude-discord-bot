import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

export interface Project {
  name: string;
  dir: string;
  isGit: boolean;
}

const IGNORED = new Set(['node_modules', 'Library', 'Applications']);

/** PROJECTS_ROOT 바로 아래의 디렉터리를 프로젝트로 취급합니다. */
export function listProjects(): Project[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(config.projectsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith('.') && !IGNORED.has(e.name))
    .map((e) => {
      const dir = path.join(config.projectsRoot, e.name);
      return { name: e.name, dir, isGit: fs.existsSync(path.join(dir, '.git')) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 사용자가 지정한 프로젝트 이름을 실제 경로로 변환합니다.
 * PROJECTS_ROOT 밖으로 벗어나는 경로는 거부합니다 (path traversal 방지).
 */
export function resolveProject(name: string): Project {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('프로젝트 이름이 비어 있습니다.');

  const dir = path.resolve(config.projectsRoot, trimmed);
  const root = config.projectsRoot;
  const withinRoot = dir === root || dir.startsWith(root + path.sep);
  if (!withinRoot) {
    throw new Error(`프로젝트 경로가 ${root} 밖입니다: ${trimmed}`);
  }

  const real = fs.realpathSync.native(dir); // 심볼릭 링크 탈출도 차단
  const realRoot = fs.realpathSync.native(root);
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    throw new Error(`심볼릭 링크가 ${root} 밖을 가리킵니다: ${trimmed}`);
  }
  if (!fs.statSync(real).isDirectory()) {
    throw new Error(`디렉터리가 아닙니다: ${trimmed}`);
  }

  return { name: path.relative(realRoot, real) || path.basename(real), dir: real, isGit: fs.existsSync(path.join(real, '.git')) };
}

/** 주어진 절대 경로가 프로젝트 디렉터리 안에 있는지 검사합니다. */
export function isInsideProject(projectDir: string, targetPath: string): boolean {
  if (!targetPath) return false;
  const abs = path.isAbsolute(targetPath) ? targetPath : path.resolve(projectDir, targetPath);
  const normalized = path.normalize(abs);
  return normalized === projectDir || normalized.startsWith(projectDir + path.sep);
}
