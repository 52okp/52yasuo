import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  compressArchive,
  findEngine,
  run7z,
  splitSingleVolume,
  testArchive
} from '../src/engine.ts';
import { MB, listVolumeFiles } from '../src/volumes.ts';
import type { EngineInfo } from '../src/types.ts';

let engine: EngineInfo | null = null;
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compress-engine-'));
  tempDirs.push(dir);
  return dir;
}

async function makeSourceFiles(dir: string, randomBytes = 0): Promise<string[]> {
  const files = [path.join(dir, '文档.txt'), path.join(dir, '重复数据.txt')];
  await fsp.writeFile(files[0]!, '你好，7-Zip 压缩测试。\n'.repeat(50));
  await fsp.writeFile(files[1]!, 'abcdefgh'.repeat(5000));
  if (randomBytes > 0) {
    const randomFile = path.join(dir, '随机数据.bin');
    await fsp.writeFile(randomFile, crypto.randomBytes(randomBytes));
    files.push(randomFile);
  }
  return files;
}

beforeAll(async () => {
  engine = await findEngine('');
});

afterAll(async () => {
  for (const dir of tempDirs) {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

describe.skipIf(process.env.SKIP_ENGINE_TESTS === '1')('真实 7-Zip 集成测试', () => {
  it('引擎可被探测到', () => {
    expect(engine).not.toBeNull();
    expect(engine!.version).toMatch(/7-Zip/);
  });

  it('COMPRESS_ENGINE_PATH 环境变量指定的内置引擎优先于 PATH', async () => {
    const bundled = path.resolve('vendor/7z.exe');
    const previous = process.env.COMPRESS_ENGINE_PATH;
    process.env.COMPRESS_ENGINE_PATH = bundled;
    try {
      const found = await findEngine('');
      expect(found).not.toBeNull();
      expect(found!.path.toLowerCase()).toBe(bundled.toLowerCase());
    } finally {
      if (previous === undefined) delete process.env.COMPRESS_ENGINE_PATH;
      else process.env.COMPRESS_ENGINE_PATH = previous;
    }
  });

  it('小文件高压缩率：仍保证至少两卷，且分卷可被 7-Zip 识别与测试', async () => {
    expect(engine).not.toBeNull();
    const dir = makeTempDir();
    const sourceDir = path.join(dir, 'src');
    const outDir = path.join(dir, 'out');
    await fsp.mkdir(sourceDir);
    await fsp.mkdir(outDir);
    const files = await makeSourceFiles(sourceDir);
    const archiveBase = path.join(outDir, 'small.7z');

    const result = await compressArchive({
      enginePath: engine!.path,
      files,
      archiveBase,
      password: 'pass-123',
      volumeBytes: 64 * MB
    });
    expect(result.code).toBe(0);

    let volumes = listVolumeFiles(await fsp.readdir(outDir), 'small');
    expect(volumes.length).toBe(1);

    const originalBytes = await fsp.readFile(path.join(outDir, volumes[0]!));
    await splitSingleVolume(path.join(outDir, volumes[0]!), archiveBase, 64 * MB);
    volumes = listVolumeFiles(await fsp.readdir(outDir), 'small');
    expect(volumes.length).toBeGreaterThanOrEqual(2);
    expect(volumes[0]).toBe('small.7z.001');
    expect(volumes[1]).toBe('small.7z.002');

    const rejoined = Buffer.concat(await Promise.all(volumes.map((v) => fsp.readFile(path.join(outDir, v)))));
    expect(rejoined.equals(originalBytes)).toBe(true);

    const outcome = await testArchive(engine!.path, path.join(outDir, volumes[0]!), 'pass-123');
    expect(outcome.status).toBe('passed');
  });

  it('正确密码可解压且内容一致，错误密码无法解密', async () => {
    expect(engine).not.toBeNull();
    const dir = makeTempDir();
    const files = await makeSourceFiles(dir);
    const archiveBase = path.join(dir, 'enc.7z');
    const result = await compressArchive({
      enginePath: engine!.path,
      files,
      archiveBase,
      password: '正确密码',
      volumeBytes: 64 * MB
    });
    expect(result.code).toBe(0);
    const volumes = listVolumeFiles(await fsp.readdir(dir), 'enc');
    await splitSingleVolume(path.join(dir, volumes[0]!), archiveBase, 64 * MB);

    const extractDir = path.join(dir, 'extracted');
    const ok = await run7z(engine!.path, ['x', '-p正确密码', `-o${extractDir}`, '-y', path.join(dir, 'enc.7z.001')]);
    expect(ok.code).toBe(0);
    const extracted = await fsp.readFile(path.join(extractDir, '文档.txt'), 'utf8');
    const original = await fsp.readFile(files[0]!, 'utf8');
    expect(extracted).toBe(original);

    const wrongDir = path.join(dir, 'wrong');
    const wrong = await run7z(engine!.path, ['x', '-p错误密码', `-o${wrongDir}`, '-y', path.join(dir, 'enc.7z.001')]);
    expect(wrong.code).not.toBe(0);

    const outcome = await testArchive(engine!.path, path.join(dir, 'enc.7z.001'), '错误密码');
    expect(outcome.status).toBe('failed');
    expect(outcome.category).toBe('wrong-password');
  });

  it('文件名加密：无正确密码不能浏览内部文件名', async () => {
    expect(engine).not.toBeNull();
    const dir = makeTempDir();
    const files = await makeSourceFiles(dir);
    const archiveBase = path.join(dir, 'hdr.7z');
    await compressArchive({
      enginePath: engine!.path,
      files,
      archiveBase,
      password: 'secret',
      volumeBytes: 64 * MB
    });
    const firstVolume = path.join(dir, 'hdr.7z.001');

    const noPassword = await run7z(engine!.path, ['l', '-p', firstVolume]);
    expect(noPassword.code).not.toBe(0);
    expect(noPassword.output).not.toContain('文档.txt');

    const wrongPassword = await run7z(engine!.path, ['l', '-pWrong', firstVolume]);
    expect(wrongPassword.code).not.toBe(0);
    expect(wrongPassword.output).not.toContain('文档.txt');

    const withPassword = await run7z(engine!.path, ['l', '-psecret', firstVolume]);
    expect(withPassword.code).toBe(0);
    expect(withPassword.output).toContain('文档.txt');
  });

  it('缺卷时测试失败并报告分卷缺失', async () => {
    expect(engine).not.toBeNull();
    const dir = makeTempDir();
    const files = await makeSourceFiles(dir, 2 * MB);
    const archiveBase = path.join(dir, 'miss.7z');
    await compressArchive({
      enginePath: engine!.path,
      files,
      archiveBase,
      password: 'pw',
      volumeBytes: 1 * MB
    });
    const volumes = listVolumeFiles(await fsp.readdir(dir), 'miss');
    expect(volumes.length).toBeGreaterThanOrEqual(2);
    await fsp.rm(path.join(dir, volumes[1]!));

    const outcome = await testArchive(engine!.path, path.join(dir, volumes[0]!), 'pw');
    expect(outcome.status).toBe('failed');
    expect(outcome.category).toBe('missing-volume');
  });

  it('数据损坏时测试失败', async () => {
    expect(engine).not.toBeNull();
    const dir = makeTempDir();
    const files = await makeSourceFiles(dir, 2 * MB);
    const archiveBase = path.join(dir, 'corrupt.7z');
    await compressArchive({
      enginePath: engine!.path,
      files,
      archiveBase,
      password: 'pw',
      volumeBytes: 1 * MB
    });
    const volumes = listVolumeFiles(await fsp.readdir(dir), 'corrupt');
    expect(volumes.length).toBeGreaterThanOrEqual(2);
    const target = path.join(dir, volumes[0]!);
    const buffer = await fsp.readFile(target);
    const middle = Math.floor(buffer.length / 2);
    buffer[middle] = buffer[middle]! ^ 0xff;
    await fsp.writeFile(target, buffer);

    const outcome = await testArchive(engine!.path, target, 'pw');
    expect(outcome.status).toBe('failed');
    expect(outcome.message.length).toBeGreaterThan(0);
  });

  it('大文件按容量原生分卷：每卷不超上限且整套测试通过', async () => {
    expect(engine).not.toBeNull();
    const dir = makeTempDir();
    const files = await makeSourceFiles(dir, 5 * MB);
    const archiveBase = path.join(dir, 'big.7z');
    const volumeBytes = 1 * MB;
    const result = await compressArchive({
      enginePath: engine!.path,
      files,
      archiveBase,
      password: 'pw',
      volumeBytes
    });
    expect(result.code).toBe(0);
    const volumes = listVolumeFiles(await fsp.readdir(dir), 'big');
    expect(volumes.length).toBeGreaterThanOrEqual(2);
    for (const name of volumes.slice(0, -1)) {
      const stat = await fsp.stat(path.join(dir, name));
      expect(stat.size).toBeLessThanOrEqual(volumeBytes);
    }
    const outcome = await testArchive(engine!.path, path.join(dir, volumes[0]!), 'pw');
    expect(outcome.status).toBe('passed');
  });
});

describe('分卷失败恢复与取消', () => {
  it('目标卷冲突时恢复完整原卷并保留既有文件', async () => {
    const dir = makeTempDir();
    const base = path.join(dir, 'restore.7z');
    const original = Buffer.from('完整的原始归档字节'.repeat(100));
    await fsp.writeFile(`${base}.001`, original);
    await fsp.writeFile(`${base}.002`, '已有数据');
    await expect(splitSingleVolume(`${base}.001`, base, 100000)).rejects.toThrow();
    expect(await fsp.readFile(`${base}.001`)).toEqual(original);
    expect(await fsp.readFile(`${base}.002`, 'utf8')).toBe('已有数据');
    expect((await fsp.readdir(dir)).sort()).toEqual(['restore.7z.001', 'restore.7z.002']);
  });

  it('切分期间取消时保留原卷且清理临时分卷', async () => {
    const dir = makeTempDir();
    const base = path.join(dir, 'cancel.7z');
    const original = Buffer.alloc(3 * MB, 42);
    await fsp.writeFile(`${base}.001`, original);
    const controller = new AbortController();
    await expect(splitSingleVolume(`${base}.001`, base, 10 * MB, () => controller.abort(), controller.signal)).rejects.toThrow();
    expect(await fsp.readFile(`${base}.001`)).toEqual(original);
    expect(await fsp.readdir(dir)).toEqual(['cancel.7z.001']);
  });

  it('进程运行时取消会终止进程并拒绝任务', async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);
    try {
      await expect(run7z(engine!.path, ['b', '-mmt1'], undefined, controller.signal)).rejects.toThrow();
    } finally { clearTimeout(timer); }
  });
});


describe.skipIf(process.platform !== 'win32')('跨盘符归档', () => {
  it('跨盘符同名文件均可恢复，临时文件已清理', async () => {
    const localDir = await fsp.mkdtemp(path.resolve('output', 'cross-drive-'));
    tempDirs.push(localDir);
    const otherDir = makeTempDir();
    if (path.parse(localDir).root.toLowerCase() === path.parse(otherDir).root.toLowerCase()) return;
    const a = path.join(localDir, 'same.txt');
    const b = path.join(otherDir, 'same.txt');
    await fsp.writeFile(a, 'local drive');
    await fsp.writeFile(b, 'other drive');
    const archiveBase = path.join(otherDir, 'cross.7z');
    const result = await compressArchive({ enginePath: engine!.path, files: [a, b], archiveBase, password: 'pw', volumeBytes: MB });
    expect(result.code).toBe(0);
    const extracted = path.join(otherDir, 'extract');
    expect((await run7z(engine!.path, ['x', '-ppw', `-o${extracted}`, '-y', `${archiveBase}.001`])).code).toBe(0);
    for (const [file, contents] of [[a, 'local drive'], [b, 'other drive']]) {
      const drive = path.parse(file!).root;
      const restored = path.join(extracted, drive.replace(/[^a-z0-9]/gi, '_'), path.relative(drive, file!));
      expect(await fsp.readFile(restored, 'utf8')).toBe(contents);
    }
    expect((await fsp.readdir(otherDir)).some(name => name.startsWith('.sources-'))).toBe(false);
  });
});
