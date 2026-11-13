import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FileEntry, ScanResult } from './types.ts';

export async function scanPaths(inputPaths: string[], signal?: AbortSignal): Promise<ScanResult> {
  const files: FileEntry[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  const visitedDirs = new Set<string>();

  const addFile = async (filePath: string) => {
    const key = filePath.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    try {
      const stat = await fsp.stat(filePath);
      files.push({ path: filePath, size: stat.size });
    } catch (err) {
      errors.push(`无法读取文件 ${filePath}：${(err as Error).message}`);
    }
  };

  const walkDir = async (dir: string) => {
    signal?.throwIfAborted();
    const key = process.platform === 'win32' ? dir.toLowerCase() : dir;
    if (visitedDirs.has(key)) return;
    visitedDirs.add(key);
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      errors.push(`无法读取目录 ${dir}：${(err as Error).message}`);
      return;
    }
    for (const entry of entries) {
      signal?.throwIfAborted();
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walkDir(full);
      } else if (entry.isFile()) {
        await addFile(full);
      } else if (entry.isSymbolicLink()) {
        errors.push(`已跳过符号链接 ${full}（避免循环引用）`);
      }
    }
  };

  for (const raw of inputPaths) {
    signal?.throwIfAborted();
    const trimmed = raw.trim().replace(/^"|"$/g, '');
    if (!trimmed) continue;
    const resolved = path.resolve(trimmed);
    try {
      const stat = await fsp.stat(resolved);
      if (stat.isDirectory()) {
        await walkDir(resolved);
      } else if (stat.isFile()) {
        await addFile(resolved);
      } else {
        errors.push(`不支持的路径类型：${resolved}`);
      }
    } catch (err) {
      signal?.throwIfAborted();
      errors.push(`路径不存在或无法访问 ${resolved}：${(err as Error).message}`);
    }
  }

  files.sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'));
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  return { files, totalBytes, errors };
}

export interface BrowseEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
}

export interface BrowseResult {
  current: string;
  parent: string | null;
  entries: BrowseEntry[];
  truncated: boolean;
}

const MAX_BROWSE_ENTRIES = 2000;

export async function browseDirectory(dirPath: string): Promise<BrowseResult> {
  if (!dirPath) {
    const drives: BrowseEntry[] = [];
    if (process.platform === 'win32') {
      for (let code = 65; code <= 90; code++) {
        const drive = `${String.fromCharCode(code)}:\\`;
        try {
          await fsp.access(drive);
          drives.push({ name: drive, path: drive, isDir: true, size: 0 });
        } catch {
          // 该盘符不存在
        }
      }
    } else {
      drives.push({ name: '/', path: '/', isDir: true, size: 0 });
    }
    return { current: '', parent: null, entries: drives, truncated: false };
  }

  const resolved = path.resolve(dirPath);
  const dirents = await fsp.readdir(resolved, { withFileTypes: true });
  dirents.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-CN');
  });
  const entries: BrowseEntry[] = [];
  for (const dirent of dirents.slice(0, MAX_BROWSE_ENTRIES)) {
    const full = path.join(resolved, dirent.name);
    let size = 0;
    if (dirent.isFile()) {
      try {
        size = (await fsp.stat(full)).size;
      } catch {
        size = 0;
      }
    }
    entries.push({ name: dirent.name, path: full, isDir: dirent.isDirectory(), size });
  }
  const parentPath = path.dirname(resolved);
  return {
    current: resolved,
    parent: parentPath === resolved ? null : parentPath,
    entries,
    truncated: dirents.length > MAX_BROWSE_ENTRIES
  };
}

export async function checkOutputDir(outputDir: string, requiredBytes: number): Promise<void> {
  await fsp.mkdir(outputDir, { recursive: true });
  const probe = path.join(outputDir, `.write-probe-${Date.now()}.tmp`);
  try {
    await fsp.writeFile(probe, 'probe');
  } catch (err) {
    throw new Error(`输出目录不可写（${outputDir}）：${(err as Error).message}`);
  } finally {
    await fsp.rm(probe, { force: true });
  }
  try {
    const stats = await fsp.statfs(outputDir);
    const freeBytes = stats.bavail * stats.bsize;
    if (freeBytes < requiredBytes) {
      throw new Error(
        `输出目录所在磁盘空间不足：剩余 ${(freeBytes / 1024 / 1024 / 1024).toFixed(1)} GB，` +
        `本次任务至少需要预留 ${(requiredBytes / 1024 / 1024 / 1024).toFixed(1)} GB`
      );
    }
  } catch (err) {
    if ((err as Error).message.includes('空间不足')) throw err;
    // statfs 在个别文件系统上不可用时跳过空间检查
  }
}