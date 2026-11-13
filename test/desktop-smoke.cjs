/* global require, process, console, setTimeout, __dirname */
/* eslint-disable @typescript-eslint/no-require-imports -- Electron standalone CommonJS test entry */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
let server;
app.whenReady().then(async () => {
  const root = path.resolve(__dirname, '..');
  process.env.COMPRESS_ENGINE_PATH = path.join(root, 'vendor', '7z.exe');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'compress-ui-'));
  const { createContext, createAppServer } = await import(pathToFileURL(path.join(root, 'dist', 'server.js')).href);
  const ctx = createContext({ configPath: path.join(temp, 'config.json'), publicDir: path.join(root, 'public'), defaultOutputDir: path.join(temp, 'out') });
  server = createAppServer(ctx);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { titleBarOptions } = await import(pathToFileURL(path.join(root, 'electron', 'window-style.js')).href);
  const win = new BrowserWindow({ ...titleBarOptions, show: false, width: 1100, height: 860, webPreferences: { preload: path.join(root, 'electron', 'preload.cjs'), offscreen: true, backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const errors = [];
  win.webContents.on('console-message', (_event, level, message) => { if (level === 3) errors.push(message); });
  await win.loadURL(`http://127.0.0.1:${server.address().port}`);
  const evaluate = code => win.webContents.executeJavaScript(code);
  const wait = async code => {
    const until = Date.now() + 30000;
    while (!await evaluate(code)) {
      if (Date.now() > until) throw new Error(`UI timeout: ${code}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  };
  await wait(`document.getElementById('engine-status').classList.contains('ok')`);
  const titlebar = await evaluate(`(() => {
    const bar = $('window-titlebar');
    return { height: bar.getBoundingClientRect().height, drag: getComputedStyle(bar).getPropertyValue('-webkit-app-region'),
      contentTop: document.querySelector('main').getBoundingClientRect().top,
      overlay: navigator.windowControlsOverlay?.visible };
  })()`);
  if (titlebar.height !== 32 || titlebar.contentTop < 32 || titlebar.drag !== 'drag' || !titlebar.overlay) throw new Error(`标题栏配置异常：${JSON.stringify(titlebar)}`);
  const input = path.join(temp, '界面测试.txt');
  await fs.writeFile(input, '真实桌面界面测试'.repeat(500));
  await evaluate(`$('password').value = 'ui-password'; $('auto-test').checked = true; $('volume-override').value = '2'; addPaths([${JSON.stringify(input)}]);`);
  await wait(`state.scan?.files.length === 1`);
  await evaluate(`$('btn-start').click()`);
  await wait(`$('task-phase').textContent === '完成'`);
  const saved = JSON.parse(await fs.readFile(path.join(temp, 'config.json'), 'utf8'));
  if (saved.password !== 'ui-password' || saved.volumeSizeMB !== 2) throw new Error('开始任务时设置没有保存');
  if (ctx.taskManager.getSnapshot().result.test !== 'passed') throw new Error('UI 任务未通过自动测试');
  await evaluate(`$('volume-override').value = '0.5'; $('btn-start').click()`);
  await wait(`!$('notice').hidden && !$('btn-start').disabled`);
  await evaluate(`$('btn-dismiss-notice').click(); $('volume-override').value = '2'; $('task-phase').scrollIntoView({block:'center'});`);
  await new Promise(resolve => setTimeout(resolve, 300));
  const screenshot = path.join(root, 'output', 'verification', 'desktop.png');
  await fs.mkdir(path.dirname(screenshot), { recursive: true });
  await fs.writeFile(screenshot, (await win.webContents.capturePage()).toPNG());
  await win.reload();
  await wait(`$('password').value === 'ui-password'`);
  await evaluate(`state.addedPaths = []; renderAddedPaths(); rescan();`);
  await wait(`$('scan-summary').textContent === '尚未添加文件'`);
  const folder = path.join(temp, '拖入文件夹');
  await fs.mkdir(path.join(folder, '子目录'), { recursive: true });
  await fs.writeFile(path.join(folder, '甲.txt'), '拖入测试');
  await fs.writeFile(path.join(folder, '子目录', '乙.txt'), '递归测试');
  win.webContents.debugger.attach('1.3');
  await evaluate(`$('file-drop-zone').scrollIntoView();`);
  const point = await evaluate(`(() => { const r = $('drop-hint').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  const dragData = { items: [], files: [folder, input], dragOperationsMask: 1 };
  const drop = async () => {
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
      await win.webContents.debugger.sendCommand('Input.dispatchDragEvent', { type, ...point, data: dragData });
    }
  };
  await drop();
  await wait(`state.addedPaths.length === 2 && state.scan?.files.length === 3`);
  await drop();
  await new Promise(resolve => setTimeout(resolve, 400));
  if (!await evaluate(`state.addedPaths.length === 2 && !$('file-drop-zone').classList.contains('drag-over')`)) throw new Error('重复拖入去重或高亮清理失败');
  win.webContents.debugger.detach();
  await fs.writeFile(path.join(root, 'output', 'verification', 'drag-drop.png'), (await win.webContents.capturePage()).toPNG());
  const sample = '屿鱼_No_092_碧蓝航线·安克雷奇（泳装·皮肤）38P_507MB';
  const sampleFolder = path.join(temp, sample);
  await fs.mkdir(sampleFolder);
  await fs.writeFile(path.join(sampleFolder, '图片.txt'), '候选名称测试');
  await evaluate(`state.addedPaths = []; addPaths([${JSON.stringify(sampleFolder)}]); $('archive-name').scrollIntoView({block:'center'});`);
  await wait(`state.scan?.files.length === 1`);
  await evaluate(`Array.from($('name-tags').querySelectorAll('button')).find(b => b.textContent === '屿鱼_No_092').click();`);
  if (!await evaluate(`$('archive-name').value === '屿鱼_No_092'`)) throw new Error('候选名称点击填入失败');
  await evaluate(`$('btn-start').click();`);
  await wait(`state.taskId > 1 && $('task-phase').textContent === '完成'`);
  if (path.basename(ctx.taskManager.getSnapshot().result.archiveBase) !== '屿鱼_No_092.7z') throw new Error('归档未使用所选名称');
  await evaluate(`$('archive-name').value = '自定义名称'; $('archive-name').dispatchEvent(new Event('input')); renderAddedPaths();`);
  if (!await evaluate(`$('archive-name').value === '自定义名称' && !$('name-tags').querySelector('[aria-pressed="true"]')`)) throw new Error('候选标签覆盖了手动编辑名称');
  await evaluate(`$('archive-name').scrollIntoView({block:'center'});`);
  await new Promise(resolve => setTimeout(resolve, 200));
  await fs.writeFile(path.join(root, 'output', 'verification', 'name-tags.png'), (await win.webContents.capturePage()).toPNG());
  // 检查双栏与窄窗口回退，并保存实际界面截图。
  for (const [width, height] of [[1320, 900], [1100, 860], [860, 720]]) {
    win.setSize(width, height);
    await evaluate(`window.scrollTo(0, 0); document.querySelectorAll('.workspace-column').forEach(el => el.scrollTop = 0);`);
    await new Promise(resolve => setTimeout(resolve, 250));
    const layout = await evaluate(`(() => {
      const left = document.querySelector('.setup-column');
      const right = document.querySelector('.task-column');
      const a = left.getBoundingClientRect(), b = right.getBoundingClientRect();
      return { wide: innerWidth >= 1000, sideBySide: b.left >= a.right,
        stacked: b.top >= a.bottom,
        overflow: document.documentElement.scrollWidth > innerWidth || [left,right].some(el => el.scrollWidth > el.clientWidth + 1) };
    })()`);
    if (layout.overflow || (layout.wide ? !layout.sideBySide : !layout.stacked)) throw new Error(`布局检查失败 ${width}: ${JSON.stringify(layout)}`);
    await fs.writeFile(path.join(root, 'output', 'verification', `layout-${width}.png`), (await win.webContents.capturePage()).toPNG());
    if (!layout.wide) {
      await evaluate(`window.scrollTo(0, document.body.scrollHeight);`);
      if (!await evaluate(`Math.abs($('window-titlebar').getBoundingClientRect().top) < 1`)) throw new Error('窄窗口滚动后标题栏不可用');
      await evaluate(`window.scrollTo(0, 0);`);
    }
  }
  win.setSize(1320, 900);
  await evaluate(`$('manual-test-details').open = true; $('task-log-details').open = true;`);
  if (!await evaluate(`$('btn-manual-test').getClientRects().length > 0 && $('task-log').getClientRects().length > 0`)) throw new Error('折叠功能无法展开');
  await evaluate(`$('manual-test-details').open = false; $('task-log-details').open = false; document.querySelectorAll('.workspace-column').forEach(el => el.scrollTop = 0);`);
  // 预览500 MB：保持原阶梯默认值，按卷数修改后实时重新计算。
  await evaluate(`state.scan = {files:[{path:'preview',size:500*1024*1024}], totalBytes:500*1024*1024, errors:[]}; $('btn-volume-auto').click();`);
  await wait(`state.plan?.volumeBytes === 64*1024*1024 && $('volume-count').value === '8'`);
  await evaluate(`$('volume-count').value = '2'; $('volume-count').dispatchEvent(new Event('input'));`);
  await wait(`state.plan?.volumeBytes === 250*1024*1024`);
  await evaluate(`$('btn-volume-more').click();`);
  await wait(`state.plan?.volumeBytes === Math.ceil(500*1024*1024/3)`);
  await evaluate(`$('volume-count').value = '1'; $('volume-count').dispatchEvent(new Event('input'));`);
  await wait(`!state.plan && $('volume-plan').textContent.includes('2 至 10000')`);
  await evaluate(`$('btn-volume-auto').click();`);
  await wait(`state.plan?.volumeBytes === 64*1024*1024 && $('volume-count').value === '8'`);
  await evaluate(`$('volume-count').value = '2'; $('volume-count').dispatchEvent(new Event('input'));`);
  await wait(`state.plan?.volumeBytes === 250*1024*1024`);
  await evaluate(`$('volume-controller').scrollIntoView({block:'center'});`);
  await new Promise(resolve => setTimeout(resolve, 250));
  await fs.writeFile(path.join(root, 'output', 'verification', 'volume-controller.png'), (await win.webContents.capturePage()).toPNG());
  // 恢复真实扫描，验证压缩任务收到计划卷数并使用实际源大小计算。
  await evaluate(`state.addedPaths = []; addPaths([${JSON.stringify(input)}]);`);
  await wait(`state.scan?.totalBytes === 12000 && state.plan?.volumeBytes === 6000`);
  const previousTaskId = ctx.taskManager.getSnapshot().id;
  await evaluate(`$('btn-start').click();`);
  await wait(`state.taskId > ${previousTaskId} && $('task-phase').textContent === '完成'`);
  if (ctx.taskManager.getSnapshot().plan.volumeBytes !== 6000 || ctx.taskManager.getSnapshot().result.test !== 'passed') throw new Error('实际压缩未使用按卷数计算的容量');
  await evaluate(`$('btn-clear-files').click();`);
  await wait(`state.scan === null && $('volume-count').disabled && $('volume-capacity').textContent === '—'`);
  if (errors.length) throw new Error(errors.join('\n'));
  await fs.writeFile(path.join(root, 'output', 'verification', 'desktop-result.txt'), 'PASS: settings saved; archive tested; invalid capacity rejected; password restored; file list cleared; native folder and file drop; recursive scan; duplicate drop; keyword tags; selected archive name; manual name preserved; volume count preview; reset; invalid count; actual volume capacity; desktop columns; narrow layout; collapsible panels; custom titlebar; native controls overlay');
  console.log('DESKTOP_SMOKE_PASS: 保存设置、真实压缩测试、非法容量反馈、重载密码、清空文件列表、拖入文件夹与文件、递归统计、重复拖入去重、关键词标签、选定名称压缩、保留手动名称、分卷控制器预览、恢复自动、实际容量一致、左右布局、窄窗口与折叠面板、融合标题栏与原生窗口按钮');
  win.destroy();
  await new Promise(resolve => server.close(resolve));
  await fs.rm(temp, { recursive: true, force: true });
  app.exit(0);
}).catch(error => { console.error(error); if (server) server.close(); app.exit(1); });
