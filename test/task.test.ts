import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findEngine, run7z } from '../src/engine.ts';
import { TaskManager } from '../src/task.ts';
import type { AppConfig, TaskSnapshot } from '../src/types.ts';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compress-task-'));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of tempDirs) {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

async function waitForIdle(manager: TaskManager, timeoutMs = 120000): Promise<TaskSnapshot> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const snapshot = manager.getSnapshot();
    if (snapshot.status !== 'running') return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('任务超时未结束');
}

describe.skipIf(process.env.SKIP_ENGINE_TESTS === '1')('任务管理端到端', () => {
  it('完整流程：压缩 → 至少两卷 → 自动测试通过；任务密码不受运行期配置修改影响', async () => {
    const engine = await findEngine('');
    expect(engine).not.toBeNull();
    const dir = makeTempDir();
    const sourceDir = path.join(dir, 'src');
    const outputDir = path.join(dir, 'out');
    await fsp.mkdir(sourceDir);
    await fsp.writeFile(path.join(sourceDir, '甲.txt'), '内容A'.repeat(200));
    await fsp.mkdir(path.join(sourceDir, '子目录'));
    await fsp.writeFile(path.join(sourceDir, '子目录', '甲.txt'), '同名但不同内容');
    await fsp.writeFile(path.join(sourceDir, '子目录', '乙.txt'), '内容B'.repeat(200));

    let config: AppConfig = {
      password: '任务密码',
      outputDir,
      volumeSizeMB: 64,
      enginePath: engine!.path,
      autoTest: true
    };
    const manager = new TaskManager(() => config);
    manager.startCompress({ paths: [sourceDir], archiveName: '批量' });
    config = { ...config, password: '运行期间被修改的密码' };

    const snapshot = await waitForIdle(manager);
    expect(snapshot.status).toBe('completed');
    expect(snapshot.fileCount).toBe(3);
    expect(snapshot.result).not.toBeNull();
    expect(snapshot.result!.volumeCount).toBeGreaterThanOrEqual(2);
    expect(snapshot.result!.compression).toBe('success');
    expect(snapshot.result!.test).toBe('passed');
    expect(snapshot.result!.archiveBase).toContain('批量.7z');
    const extracted = path.join(dir, 'extract');
    const extraction = await run7z(engine!.path, ['x', '-p任务密码', `-o${extracted}`, '-y', snapshot.result!.volumes[0]!]);
    expect(extraction.code).toBe(0);
    expect(await fsp.readFile(path.join(extracted, '子目录', '乙.txt'), 'utf8')).toBe('内容B'.repeat(200));
    expect(await fsp.readFile(path.join(extracted, '子目录', '甲.txt'), 'utf8')).toBe('同名但不同内容');
    expect(await fsp.readFile(path.join(extracted, '甲.txt'), 'utf8')).toBe('内容A'.repeat(200));
  }, 180000);

  it('输出重名自动编号，不覆盖已有压缩包', async () => {
    const engine = await findEngine('');
    expect(engine).not.toBeNull();
    const dir = makeTempDir();
    const sourceFile = path.join(dir, 'file.txt');
    const outputDir = path.join(dir, 'out');
    await fsp.mkdir(outputDir);
    await fsp.writeFile(sourceFile, 'data'.repeat(100));
    await fsp.writeFile(path.join(outputDir, '同名.7z.001'), '占位内容，不可被覆盖');

    const config: AppConfig = {
      password: 'pw',
      outputDir,
      volumeSizeMB: null,
      enginePath: engine!.path,
      autoTest: false
    };
    const manager = new TaskManager(() => config);
    manager.startCompress({ paths: [sourceFile], archiveName: '同名' });
    const snapshot = await waitForIdle(manager);

    expect(snapshot.status).toBe('completed');
    expect(snapshot.result!.archiveBase).toContain('同名 (2).7z');
    expect(snapshot.result!.test).toBe('untested');
    const placeholder = await fsp.readFile(path.join(outputDir, '同名.7z.001'), 'utf8');
    expect(placeholder).toBe('占位内容，不可被覆盖');
  }, 180000);

  it('运行中拒绝启动第二个任务', async () => {
    const engine = await findEngine('');
    expect(engine).not.toBeNull();
    const dir = makeTempDir();
    const sourceFile = path.join(dir, 'file.txt');
    await fsp.writeFile(sourceFile, 'x'.repeat(1000));
    const config: AppConfig = {
      password: 'pw',
      outputDir: path.join(dir, 'out'),
      volumeSizeMB: null,
      enginePath: engine!.path,
      autoTest: false
    };
    const manager = new TaskManager(() => config);
    manager.startCompress({ paths: [sourceFile] });
    expect(() => manager.startCompress({ paths: [sourceFile] })).toThrow(/已有任务/);
    await waitForIdle(manager);
  }, 180000);

  it('手动测试入口：正确密码通过，错误密码失败', async () => {
    const engine = await findEngine('');
    expect(engine).not.toBeNull();
    const dir = makeTempDir();
    const sourceFile = path.join(dir, 'file.txt');
    const outputDir = path.join(dir, 'out');
    await fsp.writeFile(sourceFile, 'hello'.repeat(500));
    const config: AppConfig = {
      password: '原始密码',
      outputDir,
      volumeSizeMB: null,
      enginePath: engine!.path,
      autoTest: false
    };
    const manager = new TaskManager(() => config);
    manager.startCompress({ paths: [sourceFile], archiveName: 'manual' });
    const compressed = await waitForIdle(manager);
    expect(compressed.status).toBe('completed');
    const firstVolume = compressed.result!.volumes[0]!;

    manager.startManualTest({ archivePath: compressed.result!.volumes[1]!, password: '原始密码' });
    const passed = await waitForIdle(manager);
    expect(passed.status).toBe('completed');
    expect(passed.result!.test).toBe('passed');

    manager.startManualTest({ archivePath: firstVolume, password: '别的密码' });
    const failed = await waitForIdle(manager);
    expect(failed.status).toBe('failed');
    expect(failed.result!.test).toBe('failed');
  }, 180000);
});

describe('任务取消', () => {
  it('开始后立即取消，最终不显示成功且可以重新开始任务', async () => {
    const manager = new TaskManager(() => ({ password: 'pw', outputDir: 'unused', volumeSizeMB: null, enginePath: '', autoTest: true }));
    manager.startCompress({ paths: ['missing.txt'] });
    manager.cancel();
    const result = await waitForIdle(manager);
    expect(result.status).toBe('cancelled');
    expect(manager.isRunning()).toBe(false);
    expect(result.result).toBeNull();
    manager.startCompress({ paths: [] });
    expect((await waitForIdle(manager)).status).toBe('failed');
  });
});
