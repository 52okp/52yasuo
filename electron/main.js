import { app, BrowserWindow, Menu, shell, dialog } from 'electron';
import path from 'node:path';
import { titleBarOptions } from './window-style.js';
import { fileURLToPath } from 'node:url';
import { createContext, createAppServer } from '../dist/server.js';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(rootDir, '..');

const publicDir = app.isPackaged
  ? path.join(process.resourcesPath, 'public')
  : path.join(projectRoot, 'public');
const bundledEngine = app.isPackaged
  ? path.join(process.resourcesPath, 'engine', '7z.exe')
  : path.join(projectRoot, 'vendor', '7z.exe');
const windowIcon = app.isPackaged
  ? path.join(process.resourcesPath, 'icon.png')
  : path.join(projectRoot, 'buildResources', 'icon.png');

process.env.COMPRESS_ENGINE_PATH = bundledEngine;

let mainWindow = null;
let server = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    const configPath = path.join(app.getPath('userData'), 'config.json');
    const defaultOutputDir = path.join(app.getPath('documents'), '压缩输出');
    const ctx = createContext({ configPath, publicDir, defaultOutputDir });
    server = createAppServer(ctx);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;

    mainWindow = new BrowserWindow({
      ...titleBarOptions,
      width: 1320,
      height: 900,
      minWidth: 860,
      minHeight: 640,
      title: '自动压缩工具',
      icon: windowIcon,
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: path.join(rootDir, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    mainWindow.on('close', (event) => {
      if (ctx.taskManager.isRunning()) {
        event.preventDefault();
        dialog.showMessageBoxSync(mainWindow, { type: 'info', title: '任务正在运行', message: '请等待任务完成，或点击“取消任务”后再关闭窗口。' });
      }
    });
    mainWindow.once('ready-to-show', () => mainWindow.show());
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    await mainWindow.loadURL(`http://127.0.0.1:${port}`);
    console.log(`桌面客户端就绪：内置服务端口 ${port}，引擎 ${bundledEngine}`);
  }).catch((err) => {
    console.error('客户端启动失败：', err);
    app.quit();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('will-quit', () => {
    if (server) server.close();
  });
}
