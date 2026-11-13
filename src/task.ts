import fsp from 'node:fs/promises';
import path from 'node:path';
import { compressArchive, findEngine, splitSingleVolume, testArchive } from './engine.ts';
import { checkOutputDir, scanPaths } from './files.ts';
import { computeVolumePlan, listVolumeFiles, resolveArchiveName, volumeFileName } from './volumes.ts';
import type { AppConfig, EngineInfo, TaskPhase, TaskResult, TaskSnapshot } from './types.ts';

const MAX_LOG_LINES = 400;

export interface StartCompressParams {
  targetVolumes?: number | null;
  paths: string[];
  outputDir?: string;
  archiveName?: string;
  password?: string;
}

export interface StartTestParams {
  archivePath: string;
  password?: string;
}

function idleSnapshot(): TaskSnapshot {
  return {
    id: 0,
    kind: 'compress',
    status: 'idle',
    phase: 'waiting',
    progress: 0,
    log: [],
    startedAt: 0,
    finishedAt: null,
    fileCount: 0,
    totalBytes: 0,
    plan: null,
    result: null,
    error: null
  };
}

export class TaskManager {
  private snapshot: TaskSnapshot = idleSnapshot();
  private nextId = 1;
  private running = false;
  private controller = new AbortController();

  cancel(): void {
    if (this.running) this.controller.abort();
  }

  constructor(private readonly getConfig: () => AppConfig) {}

  getSnapshot(): TaskSnapshot {
    return { ...this.snapshot, log: [...this.snapshot.log] };
  }

  isRunning(): boolean {
    return this.running;
  }

  startCompress(params: StartCompressParams): void {
    if (this.running) throw new Error('已有任务正在运行，请等待完成后再启动');
    const config = { ...this.getConfig() };
    // 任务开始时固定密码，运行期间修改配置不影响本任务
    const password = params.password !== undefined ? params.password : config.password;
    const outputDir = params.outputDir?.trim() || config.outputDir;
    const archiveName = sanitizeArchiveName(params.archiveName?.trim() || 'archive');
    const targetVolumes = params.targetVolumes ?? null;
    if (targetVolumes !== null) computeVolumePlan(0, null, targetVolumes);
    this.begin('compress');
    void this.runCompress([...params.paths], outputDir, archiveName, password, config, targetVolumes).catch((err) => {
      this.fail((err as Error).message);
    });
  }

  startManualTest(params: StartTestParams): void {
    if (this.running) throw new Error('已有任务正在运行，请等待完成后再启动');
    const config = { ...this.getConfig() };
    const password = params.password !== undefined ? params.password : config.password;
    this.begin('test');
    void this.runManualTest(params.archivePath, password, config).catch((err) => {
      this.fail((err as Error).message);
    });
  }

  private begin(kind: 'compress' | 'test'): void {
    this.controller = new AbortController();
    this.running = true;
    this.snapshot = {
      ...idleSnapshot(),
      id: this.nextId++,
      kind,
      status: 'running',
      phase: 'waiting',
      startedAt: Date.now()
    };
  }

  private setPhase(phase: TaskPhase): void {
    this.snapshot.phase = phase;
    this.snapshot.progress = 0;
  }

  private log(text: string): void {
    const lines = text.split(/[\r\n]+/).filter((line) => line.trim() && !/^\s*\d{1,3}%/.test(line));
    this.snapshot.log.push(...lines);
    if (this.snapshot.log.length > MAX_LOG_LINES) {
      this.snapshot.log.splice(0, this.snapshot.log.length - MAX_LOG_LINES);
    }
  }

  private trackProgress(text: string): void {
    const matches = text.match(/(\d{1,3})%/g);
    if (matches && matches.length > 0) {
      const last = matches[matches.length - 1]!;
      this.snapshot.progress = Math.min(100, parseInt(last, 10));
    }
  }

  private fail(message: string): void {
    this.snapshot.status = this.controller.signal.aborted ? 'cancelled' : 'failed';
    this.snapshot.phase = 'done';
    this.snapshot.error = this.controller.signal.aborted ? '任务已取消；已生成的文件保留在输出目录，可能不完整。' : message;
    this.snapshot.finishedAt = Date.now();
    this.log(`错误：${message}`);
    this.running = false;
  }

  private finish(): void {
    this.snapshot.status = 'completed';
    this.snapshot.phase = 'done';
    this.snapshot.progress = 100;
    this.snapshot.finishedAt = Date.now();
    this.running = false;
  }

  private async resolveEngine(config: AppConfig): Promise<EngineInfo> {
    const engine = await findEngine(config.enginePath);
    if (!engine) {
      throw new Error('未找到 7-Zip 引擎：请安装 7-Zip 或在设置中指定 7z.exe 的完整路径');
    }
    this.log(`使用引擎：${engine.path}（${engine.version}）`);
    return engine;
  }

  private async runCompress(
    inputPaths: string[],
    outputDir: string,
    desiredName: string,
    password: string,
    config: AppConfig,
    targetVolumes: number | null
  ): Promise<void> {
    if (!outputDir) throw new Error('请先选择输出目录');
    if (!password) throw new Error('请先设置压缩密码（需求要求所有压缩包加密并加密文件名）');
    const engine = await this.resolveEngine(config);

    this.controller.signal.throwIfAborted();
    this.setPhase('scanning');
    this.log('正在统计待压缩文件…');
    const scan = await scanPaths(inputPaths, this.controller.signal);
    for (const err of scan.errors) this.log(`警告：${err}`);
    if (scan.files.length === 0) throw new Error('没有可压缩的文件，请检查添加的路径');
    this.snapshot.fileCount = scan.files.length;
    this.snapshot.totalBytes = scan.totalBytes;

    const plan = computeVolumePlan(scan.totalBytes, config.volumeSizeMB, targetVolumes);
    this.snapshot.plan = plan;
    this.log(`文件数量：${scan.files.length}，总大小：${(scan.totalBytes / 1024 / 1024).toFixed(2)} MB`);
    this.log(`分卷方案：${plan.reason}；按源文件大小预计 ${plan.estimatedVolumes} 卷（最终卷数以实际压缩结果为准，且保证至少 2 卷）`);

    const sourceDirs: string[] = [];
    for (const input of inputPaths) {
      const resolved = path.resolve(input.trim().replace(/^"|"$/g, ''));
      try {
        const stat = await fsp.stat(resolved);
        sourceDirs.push(stat.isDirectory() ? resolved : path.dirname(resolved));
      } catch { /* 扫描阶段已经记录不可读取的路径 */ }
    }
    const crossDrive = new Set(sourceDirs.map((dir) => path.parse(dir).root.toLowerCase())).size > 1;
    if (crossDrive) this.log('跨盘符输入：归档内按盘符分组，正在准备文件；可能需要额外复制空间');
    await checkOutputDir(outputDir, scan.totalBytes * (crossDrive ? 2 : 1) + Math.min(plan.volumeBytes, scan.totalBytes + 64 * 1024 * 1024) * 2 + 64 * 1024 * 1024);
    const dirEntries = await fsp.readdir(outputDir);
    const archiveName = resolveArchiveName(dirEntries, desiredName);
    if (archiveName !== desiredName) {
      this.log(`输出重名，自动编号为：${archiveName}（不覆盖已有压缩包）`);
    }
    const archiveBase = path.join(outputDir, `${archiveName}.7z`);

    this.setPhase('compressing');
    this.log('开始压缩（7z 格式、AES-256 内容加密、文件名加密、启用分卷）…');
    const warnings: string[] = [...scan.errors];
    const result = await compressArchive({
      signal: this.controller.signal,
      enginePath: engine.path,
      files: scan.files.map((f) => f.path),
      sourceDirs,
      archiveBase,
      password,
      volumeBytes: plan.volumeBytes,
      onChunk: (text) => {
        this.trackProgress(text);
        this.log(text);
        for (const line of text.split(/[\r\n]+/)) {
          if (/^WARNING/i.test(line.trim())) warnings.push(line.trim());
        }
      }
    });
    if (result.code !== 0 && result.code !== 1) {
      throw new Error(`7-Zip 压缩失败（退出码 ${result.code}），详见日志原始输出`);
    }
    const compression: TaskResult['compression'] = result.code === 1 || warnings.length > 0 ? 'warning' : 'success';
    if (result.code === 1) this.log('7-Zip 报告警告（退出码 1），任务未完全成功，请检查日志');

    let volumeNames = listVolumeFiles(await fsp.readdir(outputDir), archiveName);
    if (volumeNames.length === 0) throw new Error('压缩结束但未找到任何分卷文件');

    if (volumeNames.length === 1) {
      this.setPhase('splitting');
      this.log('压缩结果不足两卷，按实际压缩大小切分为至少两个 7-Zip 兼容分卷…');
      await splitSingleVolume(
        path.join(outputDir, volumeNames[0]!),
        archiveBase,
        plan.volumeBytes,
        (done, total) => {
          this.snapshot.progress = Math.round((done / total) * 100);
        },
        this.controller.signal
      );
      volumeNames = listVolumeFiles(await fsp.readdir(outputDir), archiveName);
      this.log(`切分完成，共 ${volumeNames.length} 卷`);
    }

    const volumes = volumeNames.map((name) => path.join(outputDir, name));
    const taskResult: TaskResult = {
      archiveBase,
      volumes,
      volumeCount: volumes.length,
      compression,
      test: 'untested',
      testMessage: '',
      warnings
    };
    this.snapshot.result = taskResult;

    if (config.autoTest) {
      this.setPhase('testing');
      this.log('开始对整套分卷执行完整性测试（从首卷读取）…');
      const outcome = await testArchive(engine.path, volumes[0]!, password, (text) => {
        this.trackProgress(text);
        this.log(text);
      }, this.controller.signal);
      taskResult.test = outcome.status;
      taskResult.testMessage = outcome.message;
      this.log(`测试结果：${outcome.message}`);
      if (outcome.status === 'failed') {
        this.snapshot.status = 'failed';
        this.snapshot.phase = 'done';
        this.snapshot.error = `完整性测试失败：${outcome.message}`;
        this.snapshot.finishedAt = Date.now();
        this.running = false;
        return;
      }
    } else {
      taskResult.testMessage = '未启用自动测试，请使用手动测试入口验证分卷';
      this.log(taskResult.testMessage);
    }

    this.log(`任务完成：输出 ${archiveBase}.001 起共 ${volumes.length} 卷`);
    this.finish();
  }

  private async runManualTest(archivePath: string, password: string, config: AppConfig): Promise<void> {
    const engine = await this.resolveEngine(config);
    this.controller.signal.throwIfAborted();
    if (!archivePath.trim()) throw new Error('请提供压缩包路径');
    let firstVolume = path.resolve(archivePath.trim().replace(/^"|"$/g, ''));
    if (/\.7z\.\d{3,}$/i.test(firstVolume)) {
      firstVolume = firstVolume.replace(/\.\d{3,}$/, '.001');
    } else if (!/\.7z$/i.test(firstVolume)) {
      firstVolume = volumeFileName(`${firstVolume}.7z`, 0);
    } else {
      try { await fsp.access(firstVolume); }
      catch { firstVolume += '.001'; }
    }
    try {
      await fsp.access(firstVolume);
    } catch {
      throw new Error(`找不到首卷文件：${firstVolume}`);
    }
    const dir = path.dirname(firstVolume);
    const baseName = path.basename(firstVolume).replace(/\.\d{3,}$/, '');
    const archiveName = baseName.replace(/\.7z$/i, '');
    const volumeNames = /\.7z$/i.test(firstVolume)
      ? [path.basename(firstVolume)]
      : listVolumeFiles(await fsp.readdir(dir), archiveName);
    const archiveBase = path.join(dir, `${archiveName}.7z`);

    this.snapshot.fileCount = 0;
    this.snapshot.totalBytes = 0;
    this.setPhase('testing');
    this.log(`手动测试：${firstVolume}（共发现 ${volumeNames.length} 个分卷）`);
    const outcome = await testArchive(engine.path, firstVolume, password, (text) => {
      this.trackProgress(text);
      this.log(text);
    }, this.controller.signal);
    this.snapshot.result = {
      archiveBase,
      volumes: volumeNames.map((name) => path.join(dir, name)),
      volumeCount: volumeNames.length,
      compression: 'n/a',
      test: outcome.status,
      testMessage: outcome.message,
      warnings: []
    };
    this.log(`测试结果：${outcome.message}`);
    if (outcome.status === 'failed') {
      this.snapshot.status = 'failed';
      this.snapshot.phase = 'done';
      this.snapshot.error = `完整性测试失败：${outcome.message}`;
      this.snapshot.finishedAt = Date.now();
      this.running = false;
      return;
    }
    this.finish();
  }
}

function sanitizeArchiveName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, '_').replace(/\.7z$/i, '').trim().replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned)) throw new Error('压缩包名称不能使用 Windows 保留名称');
  if (!cleaned) throw new Error('压缩包名称不能为空');
  return cleaned;
}