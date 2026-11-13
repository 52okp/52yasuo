import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig, mergeConfig, saveConfig } from './config.ts';
import { findEngine } from './engine.ts';
import { browseDirectory, scanPaths } from './files.ts';
import { TaskManager } from './task.ts';
import { computeVolumePlan } from './volumes.ts';
import type { AppConfig, EngineInfo } from './types.ts';

const MAX_BODY_BYTES = 4 * 1024 * 1024;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

export interface AppContext {
  configPath: string;
  publicDir: string;
  config: AppConfig;
  taskManager: TaskManager;
  engineCache: { key: string; info: EngineInfo | null } | null;
}

export function createContext(options: { configPath?: string; publicDir?: string; defaultOutputDir?: string } = {}): AppContext {
  const rootDir = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(rootDir, '..');
  const configPath = options.configPath ?? process.env.COMPRESS_CONFIG_PATH ?? path.join(projectRoot, 'config.json');
  const config = loadConfig(configPath);
  if (!config.outputDir) {
    config.outputDir = options.defaultOutputDir ?? path.join(projectRoot, 'output');
  }
  const ctx: AppContext = {
    configPath,
    publicDir: options.publicDir ?? path.join(projectRoot, 'public'),
    config,
    taskManager: new TaskManager(() => ctx.config),
    engineCache: null
  };
  return ctx;
}

async function getEngine(ctx: AppContext): Promise<EngineInfo | null> {
  const key = ctx.config.enginePath;
  if (ctx.engineCache && ctx.engineCache.key === key) return ctx.engineCache.info;
  const info = await findEngine(key);
  ctx.engineCache = { key, info };
  return info;
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

function asStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`参数 ${field} 必须是字符串数组`);
  }
  return value as string[];
}

export function createAppServer(ctx: AppContext): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const host = req.headers.host || '';
      const hostname = new URL(`http://${host}`).hostname;
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostname) ||
          (req.headers.origin && req.headers.origin !== `http://${host}`)) {
        sendJson(res, 403, { error: '仅允许本机应用访问' });
        return;
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      const route = `${req.method} ${url.pathname}`;

      if (route === 'GET /api/state') {
        const engine = await getEngine(ctx);
        sendJson(res, 200, { config: ctx.config, engine, task: ctx.taskManager.getSnapshot() });
        return;
      }
      if (route === 'POST /api/cancel') {
        ctx.taskManager.cancel();
        sendJson(res, 200, { task: ctx.taskManager.getSnapshot() });
        return;
      }
      if (route === 'POST /api/config') {
        const body = (await readBody(req)) as Partial<AppConfig>;
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('设置必须是对象');
        if (body.volumeSizeMB !== undefined && body.volumeSizeMB !== null) computeVolumePlan(0, body.volumeSizeMB);
        const next = mergeConfig(ctx.config, body);
        saveConfig(ctx.configPath, next);
        ctx.config = next;
        ctx.engineCache = null;
        sendJson(res, 200, { config: ctx.config });
        return;
      }
      if (route === 'POST /api/scan') {
        const body = (await readBody(req)) as { paths?: unknown };
        const result = await scanPaths(asStringArray(body.paths, 'paths'));
        sendJson(res, 200, result);
        return;
      }
      if (route === 'POST /api/plan') {
        const body = (await readBody(req)) as { totalBytes?: unknown; volumeSizeMB?: number | null; targetVolumes?: number | null };
        if (typeof body.totalBytes !== 'number' || !Number.isFinite(body.totalBytes) || body.totalBytes < 0) {
          throw new Error('参数 totalBytes 必须是非负数字');
        }
        const override = body.volumeSizeMB === undefined ? ctx.config.volumeSizeMB : body.volumeSizeMB;
        const plan = computeVolumePlan(body.totalBytes, override, body.targetVolumes ?? null);
        sendJson(res, 200, { ...plan, recommendation: computeVolumePlan(body.totalBytes, null) });
        return;
      }
      if (route === 'GET /api/browse') {
        const result = await browseDirectory(url.searchParams.get('path') ?? '');
        sendJson(res, 200, result);
        return;
      }
      if (route === 'POST /api/task') {
        const body = (await readBody(req)) as {
          paths?: unknown;
          targetVolumes?: number | null;
          outputDir?: string;
          archiveName?: string;
          password?: string;
        };
        for (const field of ['outputDir', 'archiveName'] as const) {
          if (body[field] !== undefined && typeof body[field] !== 'string') throw new Error(`参数 ${field} 必须是字符串`);
        }
        const paths = asStringArray(body.paths, 'paths');
        if (paths.length === 0) throw new Error('请先添加待压缩文件');
        if (body.password !== undefined && typeof body.password !== 'string') {
          throw new Error('参数 password 必须是字符串');
        }
        ctx.taskManager.startCompress({
          paths,
          targetVolumes: body.targetVolumes,
          outputDir: body.outputDir,
          archiveName: body.archiveName,
          password: body.password
        });
        sendJson(res, 200, { task: ctx.taskManager.getSnapshot() });
        return;
      }
      if (route === 'GET /api/task') {
        sendJson(res, 200, ctx.taskManager.getSnapshot());
        return;
      }
      if (route === 'POST /api/test') {
        const body = (await readBody(req)) as { archivePath?: unknown; password?: unknown };
        if (typeof body.archivePath !== 'string' || !body.archivePath.trim()) {
          throw new Error('请提供首卷文件路径 archivePath');
        }
        if (body.password !== undefined && typeof body.password !== 'string') {
          throw new Error('参数 password 必须是字符串');
        }
        ctx.taskManager.startManualTest({ archivePath: body.archivePath, password: body.password });
        sendJson(res, 200, { task: ctx.taskManager.getSnapshot() });
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        sendJson(res, 404, { error: '接口不存在' });
        return;
      }
      await serveStatic(ctx.publicDir, url.pathname, res);
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message });
    }
  });
}

async function serveStatic(publicDir: string, pathname: string, res: http.ServerResponse): Promise<void> {
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const filePath = path.resolve(publicDir, relative);
  if (!filePath.startsWith(path.resolve(publicDir) + path.sep) && filePath !== path.resolve(publicDir, 'index.html')) {
    sendJson(res, 403, { error: '禁止访问' });
    return;
  }
  try {
    const data = await fsp.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: '页面不存在' });
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const ctx = createContext();
  const port = Number(process.env.PORT ?? 8765);
  const host = process.env.HOST ?? '127.0.0.1';
  const server = createAppServer(ctx);
  server.listen(port, host, () => {
    console.log(`自动压缩工具已启动：http://${host}:${port}`);
    console.log(`配置文件（明文保存密码）：${ctx.configPath}`);
  });
}