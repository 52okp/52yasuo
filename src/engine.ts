import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { computeSplitChunks, volumeFileName } from './volumes.ts';
import type { EngineInfo, TestCategory, TestOutcome } from './types.ts';

export interface RunResult {
  code: number;
  output: string;
}

export function run7z(
  enginePath: string,
  args: string[],
  onChunk?: (text: string) => void,
  signal?: AbortSignal,
  cwd?: string
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(enginePath, ['-sccUTF-8', ...args], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const abort = () => child.kill();
    signal?.addEventListener('abort', abort, { once: true });
    let output = '';
    let settled = false;
    const collect = (text: string) => {
      output = (output + text).slice(-1024 * 1024);
      onChunk?.(text);
    };
    for (const stream of [child.stdout, child.stderr]) {
      const decoder = new StringDecoder('utf8');
      stream.on('data', (data: Buffer) => collect(decoder.write(data)));
      stream.on('end', () => collect(decoder.end()));
    }
    child.on('error', (err) => {
      signal?.removeEventListener('abort', abort);
      if (!settled) {
        settled = true;
        reject(new Error(`无法启动 7-Zip 引擎（${enginePath}）：${err.message}`));
      }
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort);
      if (!settled) {
        settled = true;
        if (signal?.aborted) reject(new Error('任务已取消'));
        else resolve({ code: code ?? -1, output });
      }
    });
  });
}

const COMMON_ENGINE_PATHS = [
  'C:\\Program Files\\7-Zip\\7z.exe',
  'C:\\Program Files (x86)\\7-Zip\\7z.exe'
];

export async function findEngine(configuredPath: string): Promise<EngineInfo | null> {
  const candidates = [
    ...(configuredPath ? [configuredPath] : []),
    ...(process.env.COMPRESS_ENGINE_PATH ? [process.env.COMPRESS_ENGINE_PATH] : []),
    '7z',
    '7za',
    ...COMMON_ENGINE_PATHS
  ];
  for (const candidate of candidates) {
    try {
      const result = await run7z(candidate, ['i']);
      const match = /7-Zip[^\r\n]*/.exec(result.output);
      if (result.code === 0 && match) {
        let resolved = candidate;
        if (!path.isAbsolute(candidate)) {
          resolved = await whichOnPath(candidate) ?? candidate;
        }
        return { path: resolved, version: match[0].trim() };
      }
    } catch {
      // 尝试下一个候选路径
    }
  }
  return null;
}

async function whichOnPath(name: string): Promise<string | null> {
  const pathVar = process.env.PATH ?? '';
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE').split(';') : [''];
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir.replace(/^"|"$/g, ''), name + ext.toLowerCase());
      try {
        await fsp.access(full, fs.constants.X_OK);
        return full;
      } catch {
        // 继续查找
      }
    }
  }
  return null;
}

export interface CompressOptions {
  enginePath: string;
  files: string[];
  archiveBase: string;
  password: string;
  volumeBytes: number;
  onChunk?: (text: string) => void;
  signal?: AbortSignal;
  sourceDirs?: string[];
}

export async function compressArchive(opts: CompressOptions): Promise<RunResult> {
  if (!opts.files.length) throw new Error('没有可压缩的文件');
  const files = opts.files.map((file) => path.resolve(file));
  const roots = opts.sourceDirs?.length ? opts.sourceDirs.map((dir) => path.resolve(dir)) : files.map((file) => path.dirname(file));
  let cwd = roots[0]!;
  const root = path.parse(cwd).root.toLowerCase();
  // 跨盘符时使用临时目录按盘符分组，避免不同磁盘的同名路径合并。
  let staging: string | undefined;
  let archiveFiles = files;
  if (roots.some((dir) => path.parse(dir).root.toLowerCase() !== root)) {
    staging = await fsp.mkdtemp(path.join(path.dirname(path.resolve(opts.archiveBase)), '.sources-'));
    cwd = staging;
    archiveFiles = [];
    try {
      for (const file of files) {
        opts.signal?.throwIfAborted();
        const drive = path.parse(file).root;
        const group = drive.replace(/[^a-z0-9]/gi, '_');
        const target = path.join(staging, group, path.relative(drive, file));
        await fsp.mkdir(path.dirname(target), { recursive: true });
        try { await fsp.link(file, target); }
        catch { await fsp.copyFile(file, target, fs.constants.COPYFILE_EXCL); }
        archiveFiles.push(target);
      }
    } catch (err) {
      await fsp.rm(staging, { recursive: true, force: true });
      throw err;
    }
  } else {
    while (roots.some((dir) => {
      const relative = path.relative(cwd, dir);
      return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
    })) cwd = path.dirname(cwd);
  }
  const listFile = path.resolve(`${opts.archiveBase}.filelist.tmp`);
  const relativeFiles = archiveFiles.map((file) => path.relative(cwd, file));
  let listCreated = false;
  try {
    if (relativeFiles.some((file) => /[\r\n]/.test(file))) throw new Error('文件名包含换行符，无法生成压缩清单');
    await fsp.writeFile(listFile, relativeFiles.join('\n'), { encoding: 'utf8', flag: 'wx' });
    listCreated = true;
    return await run7z(
      opts.enginePath,
      [
        'a',
        '-t7z',
        `-p${opts.password}`,
        '-mhe=on',
        `-v${opts.volumeBytes}b`,
        '-mx=5',
        '-spd',
        '-scsUTF-8',
        '-bsp1',
        '-bse1',
        '-y',
        path.resolve(opts.archiveBase),
        `@${listFile}`
      ],
      opts.onChunk,
      opts.signal,
      cwd
    );
  } finally {
    if (listCreated) await fsp.rm(listFile, { force: true });
    if (staging) await fsp.rm(staging, { recursive: true, force: true });
  }
}

/** 把单个卷文件按字节切分为多个 7-Zip 兼容分卷（纯字节切分，可拼接还原）。 */
export async function splitSingleVolume(
  singleVolumePath: string,
  archiveBase: string,
  preferredBytes: number,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal
): Promise<string[]> {
  const stat = await fsp.stat(singleVolumePath);
  const chunks = computeSplitChunks(stat.size, preferredBytes, 2);
  const tempDir = await fsp.mkdtemp(path.join(path.dirname(singleVolumePath), '.split-'));
  const tmpPaths = chunks.map((_, i) => path.join(tempDir, String(i)));
  const finalPaths = chunks.map((_, i) => volumeFileName(archiveBase, i));
  const published: string[] = [];
  const backup = path.join(tempDir, 'original');
  let movedOriginal = false;
  try {
    const source = await fsp.open(singleVolumePath, 'r');
    let processed = 0;
    try {
      const buffer = Buffer.alloc(1024 * 1024);
      for (let i = 0; i < chunks.length; i++) {
        const target = await fsp.open(tmpPaths[i]!, 'wx');
        try {
          let remaining = chunks[i]!;
          while (remaining > 0) {
            signal?.throwIfAborted();
            const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, remaining), processed);
            if (!bytesRead) throw new Error('切分过程中源文件长度发生变化');
            let offset = 0;
            while (offset < bytesRead) {
              const { bytesWritten } = await target.write(buffer, offset, bytesRead - offset);
              if (!bytesWritten) throw new Error('分卷写入失败');
              offset += bytesWritten;
            }
            remaining -= bytesRead;
            processed += bytesRead;
            onProgress?.(processed, stat.size);
          }
          await target.sync();
        } finally { await target.close(); }
      }
    } finally { await source.close(); }
    signal?.throwIfAborted();
    // 全部临时分卷写入完成后再发布；发布失败时恢复原卷。
    await fsp.rename(singleVolumePath, backup);
    movedOriginal = true;
    for (let i = 0; i < tmpPaths.length; i++) {
      await fsp.copyFile(tmpPaths[i]!, finalPaths[i]!, fs.constants.COPYFILE_EXCL);
      published.push(finalPaths[i]!);
    }
  } catch (err) {
    for (const file of published) await fsp.rm(file, { force: true });
    if (movedOriginal) {
      try { await fsp.rename(backup, singleVolumePath); }
      catch { throw new Error(`分卷发布失败，原始压缩数据保留于：${backup}`); }
    }
    await fsp.rm(tempDir, { recursive: true, force: true });
    throw err;
  }
  await fsp.rm(tempDir, { recursive: true, force: true });
  return finalPaths;
}

export function classifyTestFailure(output: string): { category: TestCategory; message: string } {
  if (/wrong password|incorrect password|密码错误/i.test(output)) {
    return { category: 'wrong-password', message: '密码错误，无法解密压缩包内容' };
  }
  if (/cannot open encrypted archive|can not open encrypted archive|enter password/i.test(output)) {
    return { category: 'wrong-password', message: '压缩包已加密且密码不正确（或未提供密码），无法打开加密文件头' };
  }
  if (/unexpected end of archive|cannot find the file|can not find the file|can not open file|cannot open file|no such file|missing volume|there is no such archive/i.test(output)) {
    return { category: 'missing-volume', message: '分卷缺失或无法读取，请确认整套分卷都在同一目录' };
  }
  if (/data error|crc failed|headers error|corrupt|unsupported method/i.test(output)) {
    return { category: 'corrupt', message: '数据损坏或校验失败' };
  }
  return { category: 'unknown', message: '测试失败，详见引擎原始输出' };
}

export async function testArchive(
  enginePath: string,
  firstVolumePath: string,
  password: string,
  onChunk?: (text: string) => void,
  signal?: AbortSignal
): Promise<TestOutcome> {
  const args = ['t', '-bsp1', '-bse1', '-y'];
  args.push(password ? `-p${password}` : '-p');
  args.push(firstVolumePath);
  const result = await run7z(enginePath, args, onChunk, signal);
  if (result.code === 0 && /Everything is Ok/i.test(result.output)) {
    return { status: 'passed', category: null, message: '完整性测试通过：数据可读取、可解密、校验一致', raw: result.output };
  }
  const { category, message } = classifyTestFailure(result.output);
  return { status: 'failed', category, message, raw: result.output };
}