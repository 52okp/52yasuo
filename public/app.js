'use strict';

if (window.desktopFiles) document.documentElement.classList.add('desktop-window');

const $ = (id) => document.getElementById(id);

const state = {
  addedPaths: [],
  scan: null,
  polling: false,
  browseMode: 'add',
  browsePath: '',
  browseParent: null,
  browseSelected: new Map(),
  lastResult: null,
  scanVersion: 0,
  taskId: 0,
  running: false,
  starting: false,
  selectedVolumeCount: null,
  planVersion: 0,
  plan: null
};

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 'B';
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${unit}`;
}

async function api(url, body) {
  const res = await fetch(url, body === undefined ? undefined : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

function showError(err) {
  $('notice').textContent = err.message || String(err);
  $('notice').hidden = false;
}

/* ---------- 初始化 ---------- */

async function init() {
  try {
    const data = await api('/api/state');
    applyConfig(data.config);
    renderEngine(data.engine);
    renderTask(data.task);
    if (data.task.status === 'running') pollTask();
  } catch (err) {
    showError(err);
  }
}

function applyConfig(config) {
  $('password').value = config.password;
  $('output-dir').value = config.outputDir;
  $('volume-override').value = config.volumeSizeMB ?? '';
  $('auto-test').checked = config.autoTest;
  $('engine-path').value = config.enginePath;
}

function renderEngine(engine) {
  const el = $('engine-status');
  if (engine) {
    el.textContent = '7-Zip 已就绪';
    el.className = 'engine-status ok';
    el.title = `${engine.version} · ${engine.path}`;
  } else {
    el.textContent = '未找到 7-Zip 引擎，请安装或在高级设置中指定 7z.exe 路径';
    el.className = 'engine-status missing';
    el.title = '';
  }
}

/* ---------- 文件列表与扫描 ---------- */

function renderAddedPaths() {
  renderNameSuggestions();
  $('input-count').textContent = state.addedPaths.length;
  $('file-empty').hidden = state.addedPaths.length > 0;
  $('file-drop-zone').classList.toggle('has-files', state.addedPaths.length > 0);
  const list = $('added-paths');
  list.textContent = '';
  state.addedPaths.forEach((p, index) => {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.className = 'file-info';
    const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
    const name = document.createElement('strong');
    name.textContent = parts.pop() || p;
    const parent = document.createElement('small');
    parent.textContent = p;
    parent.title = p;
    span.append(name, parent);
    const icon = document.createElement('span');
    icon.className = 'file-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none"><path d="M4 7a2 2 0 0 1 2-2h5l2 3h5a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '×';
    btn.title = '移除';
    btn.setAttribute('aria-label', `移除 ${p}`);
    btn.addEventListener('click', () => {
      state.addedPaths.splice(index, 1);
      renderAddedPaths();
      void rescan();
    });
    li.append(icon, span, btn);
    list.appendChild(li);
  });
}

function renderNameSuggestions() {
  const container = $('name-tags');
  container.textContent = '';
  if (!state.addedPaths.length) {
    container.textContent = '添加文件或文件夹后显示候选名称';
    return;
  }
  for (const source of state.addedPaths) {
    const { original, names } = globalThis.archiveNameSuggestions(source);
    const group = document.createElement('div');
    group.className = 'name-tag-group';
    if (state.addedPaths.length > 1) {
      const label = document.createElement('div');
      label.className = 'hint name-tag-source';
      label.textContent = original;
      group.appendChild(label);
    }
    for (const name of names) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'name-tag';
      button.textContent = name;
      button.title = `使用名称：${name}`;
      button.setAttribute('aria-pressed', String($('archive-name').value === name));
      button.addEventListener('click', () => {
        $('archive-name').value = name;
        updateNameTagSelection();
      });
      group.appendChild(button);
    }
    container.appendChild(group);
  }
}

function updateNameTagSelection() {
  for (const button of $('name-tags').querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.textContent === $('archive-name').value));
  }
}

function addPaths(paths) {
  for (const raw of paths) {
    const p = raw.trim().replace(/^"|"$/g, '');
    if (p && !state.addedPaths.some((existing) => existing.toLowerCase() === p.toLowerCase())) {
      state.addedPaths.push(p);
    }
  }
  renderAddedPaths();
  void rescan();
}

let scanTimer = null;
function rescan() {
  clearTimeout(scanTimer);
  const version = ++state.scanVersion;
  state.scan = null;
  state.plan = null;
  state.planVersion++;
  $('volume-total').textContent = state.addedPaths.length ? '正在统计…' : '尚未添加文件';
  $('volume-recommendation').textContent = '等待统计';
  $('volume-capacity').textContent = '—';
  $('volume-plan').textContent = state.addedPaths.length ? '正在统计文件，完成后计算分卷…' : '添加文件后显示自动计算的分卷方案';
  setVolumeControls();
  scanTimer = setTimeout(async () => {
    if (state.addedPaths.length === 0) {
      state.scan = null;
      state.selectedVolumeCount = null;
      $('volume-count').value = '';
      $('scan-summary').textContent = '尚未添加文件';
      $('scan-errors').textContent = '';
      $('file-details').hidden = true;
      $('volume-plan').textContent = '添加文件后显示自动计算的分卷方案';
      return;
    }
    $('scan-summary').textContent = '正在统计文件…';
    try {
      const scan = await api('/api/scan', { paths: state.addedPaths });
      if (version !== state.scanVersion) return;
      state.scan = scan;
      $('scan-summary').textContent = `文件数量：${scan.files.length} 个；文件总大小：${formatBytes(scan.totalBytes)}（${scan.totalBytes.toLocaleString()} 字节）`;
      $('scan-errors').textContent = scan.errors.join('\n');
      renderFileTable(scan.files);
      await refreshVolumePlan();
    } catch (err) {
      if (version !== state.scanVersion) return;
      $('scan-summary').textContent = `统计失败：${err.message}`;
      $('volume-total').textContent = '统计失败';
      $('volume-plan').textContent = `无法计算分卷：${err.message}`;
    }
  }, 200);
}

function renderFileTable(files) {
  const details = $('file-details');
  details.hidden = files.length === 0;
  const tbody = $('file-table').querySelector('tbody');
  tbody.textContent = '';
  for (const file of files.slice(0, 1000)) {
    const tr = document.createElement('tr');
    const tdPath = document.createElement('td');
    tdPath.textContent = file.path;
    const tdSize = document.createElement('td');
    tdSize.className = 'num';
    tdSize.textContent = formatBytes(file.size);
    tr.append(tdPath, tdSize);
    tbody.appendChild(tr);
  }
  if (files.length > 1000) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 2;
    td.textContent = `… 其余 ${files.length - 1000} 个文件未展示（全部纳入任务）`;
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
}

function setVolumeControls() {
  const disabled = !state.scan || !state.scan.files.length || state.running || state.starting;
  for (const id of ['volume-count', 'btn-volume-less', 'btn-volume-more']) $(id).disabled = disabled;
  $('btn-volume-auto').disabled = state.running || state.starting;
  $('volume-override').disabled = state.running || state.starting;
}

function readVolumeCount() {
  if (state.selectedVolumeCount === null) return null;
  const count = Number($('volume-count').value);
  if (!Number.isSafeInteger(count) || count < 2 || count > 10000) throw new Error('计划卷数必须是 2 至 10000 之间的整数');
  return count;
}

async function refreshVolumePlan() {
  const version = ++state.planVersion;
  state.plan = null;
  setVolumeControls();
  if (!state.scan) return;
  try {
    const raw = $('volume-override').value.trim();
    const plan = await api('/api/plan', {
      totalBytes: state.scan.totalBytes,
      volumeSizeMB: raw === '' ? null : Number(raw),
      targetVolumes: readVolumeCount()
    });
    if (version !== state.planVersion) return;
    renderPlan(plan);
  } catch (err) {
    if (version !== state.planVersion) return;
    $('volume-capacity').textContent = '—';
    $('volume-plan').textContent = err.message;
  }
}

function renderPlan(plan) {
  state.plan = plan;
  const recommendation = plan.recommendation;
  $('volume-total').textContent = formatBytes(plan.totalBytes);
  $('volume-recommendation').textContent = `${Math.max(2, recommendation.estimatedVolumes)} 卷 · 每卷 ${formatBytes(recommendation.volumeBytes)}`;
  $('volume-capacity').textContent = formatBytes(plan.volumeBytes);
  if (state.selectedVolumeCount === null) $('volume-count').value = Math.max(2, plan.estimatedVolumes);
  $('volume-plan').textContent = `${plan.reason}；每卷 ${formatBytes(plan.volumeBytes)}（${plan.volumeBytes.toLocaleString()} 字节）；按源文件大小预计 ${Math.max(2, plan.estimatedVolumes)} 卷。`;
  setVolumeControls();
}

/* ---------- 设置保存 ---------- */

async function saveConfig(silent) {
  const overrideRaw = $('volume-override').value.trim();
  const volumeSizeMB = overrideRaw === '' ? null : Number(overrideRaw);
  if (volumeSizeMB !== null && (!Number.isSafeInteger(volumeSizeMB) || volumeSizeMB < 1 || volumeSizeMB > 1048576)) {
    showError(new Error('每卷容量必须是 1 至 1048576 之间的整数（MB），或留空自动计算'));
    return false;
  }
  try {
    const data = await api('/api/config', {
      password: $('password').value,
      outputDir: $('output-dir').value.trim(),
      volumeSizeMB,
      autoTest: $('auto-test').checked,
      enginePath: $('engine-path').value.trim()
    });
    if (!silent) {
      $('config-save-status').textContent = `已保存（${new Date().toLocaleTimeString()}），密码明文存于本机 config.json`;
    }
    const stateData = await api('/api/state');
    renderEngine(stateData.engine);
    applyConfigVolumeOnly(data.config);
    if (state.scan) {
      await refreshVolumePlan();
    }
    return true;
  } catch (err) {
    showError(err);
    return false;
  }
}

function applyConfigVolumeOnly(config) {
  $('volume-override').value = config.volumeSizeMB ?? '';
}

/* ---------- 任务启动与轮询 ---------- */

async function startTask() {
  if (state.addedPaths.length === 0) {
    showError(new Error('请先添加待压缩文件'));
    return;
  }
  if (!state.scan || !state.scan.files.length) {
    showError(new Error('请等待文件统计完成，并确认有可压缩文件'));
    return;
  }
  let targetVolumes;
  try { targetVolumes = readVolumeCount(); }
  catch (err) { showError(err); return; }
  if (!$('password').value) {
    showError(new Error('请先设置压缩密码'));
    return;
  }
  if (!$('output-dir').value.trim()) {
    showError(new Error('请先选择输出目录'));
    return;
  }
  state.starting = true;
  setVolumeControls();
  $('btn-start').disabled = true;
  $('btn-manual-test').disabled = true;
  $('notice').hidden = true;
  try {
    if (!await saveConfig(true)) {
      $('btn-start').disabled = false;
      $('btn-manual-test').disabled = false;
      return;
    }
    const response = await api('/api/task', {
      paths: state.addedPaths,
      targetVolumes,
      outputDir: $('output-dir').value.trim(),
      archiveName: $('archive-name').value.trim() || 'archive',
      password: $('password').value
    });
    renderTask(response.task);
    pollTask();
  } catch (err) {
    $('btn-start').disabled = false;
    $('btn-manual-test').disabled = false;
    showError(err);
  } finally {
    state.starting = false;
    setVolumeControls();
  }
}

async function pollTask() {
  if (state.polling) return;
  state.polling = true;
  const tick = async () => {
    try {
      const task = await api('/api/task');
      $('connection-status').textContent = '';
      renderTask(task);
      if (task.status === 'running') {
        setTimeout(tick, 800);
      } else {
        state.polling = false;
        $('btn-start').disabled = false;
        $('btn-manual-test').disabled = false;
      }
    } catch {
      $('connection-status').textContent = '连接中断，正在重试…任务可能仍在运行';
      setTimeout(tick, 2000);
    }
  };
  await tick();
}

const PHASE_LABELS = {
  waiting: '准备中',
  scanning: '统计文件中',
  compressing: '压缩中',
  splitting: '切分分卷中',
  testing: '测试中',
  done: '结束'
};

function renderTask(task) {
  state.running = task.status === 'running';
  setVolumeControls();
  if (task.id !== state.taskId) {
    state.taskId = task.id;
    state.lastResult = null;
    $('result-panel').textContent = '当前任务尚未生成结果';
    $('notice').hidden = true;
  }
  $('btn-cancel').hidden = !state.running;
  $('btn-cancel').disabled = !state.running;
  $('task-time').textContent = task.startedAt ? `用时 ${Math.floor(((task.finishedAt || Date.now()) - task.startedAt) / 1000)} 秒` : '';
  if (task.error) { $('notice').textContent = task.error; $('notice').hidden = false; }
  const phaseEl = $('task-phase');
  if (task.status === 'idle') {
    phaseEl.textContent = '等待';
    phaseEl.className = 'badge idle';
  } else if (task.status === 'running') {
    phaseEl.textContent = PHASE_LABELS[task.phase] || task.phase;
    phaseEl.className = 'badge running';
  } else if (task.status === 'completed') {
    const warning = task.result?.compression === 'warning';
    phaseEl.textContent = warning ? '完成，有警告' : '完成';
    phaseEl.className = warning ? 'badge warning' : 'badge completed';
  } else if (task.status === 'cancelled') {
    phaseEl.textContent = '已取消';
    phaseEl.className = 'badge idle';
  } else {
    phaseEl.textContent = '失败';
    phaseEl.className = 'badge failed';
  }
  $('progress-bar').style.width = `${task.progress}%`;
  $('progress-text').textContent = `${task.progress}%`;
  $('progress-bar').parentElement.setAttribute('aria-valuenow', String(task.progress));
  const log = $('task-log');
  const follow = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  $('task-log').textContent = task.log.length > 0 ? task.log.join('\n') : (task.error || '暂无任务');
  if (follow) log.scrollTop = log.scrollHeight;
  $('btn-start').disabled = task.status === 'running';
  $('btn-manual-test').disabled = task.status === 'running';
  if (task.result) {
    state.lastResult = task.result;
    renderResult(task);
    if (task.kind === 'compress') {
      $('test-archive').value = task.result.volumes[0] || `${task.result.archiveBase}.001`;
    }
  }
}

function renderResult(task) {
  const r = task.result;
  const panel = $('result-panel');
  panel.textContent = '';
  const dl = document.createElement('dl');
  dl.className = 'kv';
  const addRow = (label, valueNode) => {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    if (typeof valueNode === 'string') dd.textContent = valueNode;
    else dd.appendChild(valueNode);
    dl.append(dt, dd);
  };
  addRow('输出位置', r.volumes[0] || r.archiveBase);
  addRow('最终卷数', `${r.volumeCount} 卷`);
  if (task.kind === 'compress') {
    const compressionText = { success: '成功', warning: '完成但有警告（未完全成功）', failed: '失败', 'n/a': '不适用' }[r.compression];
    addRow('压缩结果', compressionText);
  }
  const testSpan = document.createElement('span');
  if (r.test === 'passed') {
    testSpan.className = 'test-pass';
    testSpan.textContent = `测试通过 — ${r.testMessage}`;
  } else if (r.test === 'failed') {
    testSpan.className = 'test-fail';
    testSpan.textContent = `测试失败 — ${r.testMessage}`;
  } else {
    testSpan.className = 'test-untested';
    testSpan.textContent = `未测试 — ${r.testMessage || '尚未执行完整性测试'}`;
  }
  addRow('测试结果', testSpan);
  if (r.warnings.length > 0) {
    addRow('警告', r.warnings.join('\n'));
  }
  if (task.error) {
    addRow('错误信息', task.error);
  }
  panel.appendChild(dl);
}

async function manualTest() {
  const archivePath = $('test-archive').value.trim();
  if (!archivePath) {
    showError(new Error('请填写首卷路径（例如 X:\\output\\archive.7z.001）'));
    return;
  }
  $('btn-manual-test').disabled = true;
  try {
    const body = { archivePath };
    if ($('test-password').value) body.password = $('test-password').value;
    const response = await api('/api/test', body);
    renderTask(response.task);
    pollTask();
  } catch (err) {
    $('btn-manual-test').disabled = false;
    showError(err);
  }
}

/* ---------- 目录浏览器 ---------- */

function openBrowse(mode) {
  state.browseMode = mode;
  state.browseSelected.clear();
  $('browse-title').textContent = mode === 'add' ? '选择文件或文件夹（可多选）' : '选择输出目录';
  $('btn-browse-confirm').textContent = mode === 'add' ? '添加所选' : '选择当前目录';
  $('browse-modal').hidden = false;
  void loadBrowse(mode === 'output' ? $('output-dir').value.trim() : state.browsePath);
}

async function loadBrowse(dirPath) {
  try {
    const data = await api(`/api/browse?path=${encodeURIComponent(dirPath)}`);
    state.browsePath = data.current;
    state.browseParent = data.parent;
    $('browse-current').textContent = data.current || '此电脑（驱动器列表）';
    $('btn-browse-up').disabled = data.current === '';
    const list = $('browse-list');
    list.textContent = '';
    if (data.truncated) {
      const tip = document.createElement('div');
      tip.className = 'browse-item hint';
      tip.textContent = '目录条目过多，仅显示前 2000 项';
      list.appendChild(tip);
    }
    for (const entry of data.entries) {
      const row = document.createElement('div');
      row.className = 'browse-item';
      if (state.browseMode === 'add') {
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = state.browseSelected.has(entry.path);
        cb.addEventListener('change', () => {
          if (cb.checked) state.browseSelected.set(entry.path, entry);
          else state.browseSelected.delete(entry.path);
          $('browse-selected-count').textContent = `已选 ${state.browseSelected.size} 项`;
        });
        row.appendChild(cb);
      }
      const name = document.createElement('span');
      name.className = entry.isDir ? 'name dir' : 'name';
      name.textContent = (entry.isDir ? '📁 ' : '📄 ') + entry.name;
      if (entry.isDir) {
        name.addEventListener('dblclick', () => void loadBrowse(entry.path));
        const openBtn = document.createElement('button');
        openBtn.type = 'button';
        openBtn.className = 'secondary';
        openBtn.textContent = '打开';
        openBtn.addEventListener('click', () => void loadBrowse(entry.path));
        row.append(name, openBtn);
      } else {
        const size = document.createElement('span');
        size.className = 'size';
        size.textContent = formatBytes(entry.size);
        row.append(name, size);
      }
      list.appendChild(row);
    }
    $('browse-selected-count').textContent = `已选 ${state.browseSelected.size} 项`;
  } catch (err) {
    showError(err);
  }
}

function confirmBrowse() {
  if (state.browseMode === 'add') {
    const paths = [...state.browseSelected.keys()];
    if (paths.length === 0) {
      showError(new Error('请先勾选要添加的文件或文件夹'));
      return;
    }
    addPaths(paths);
  } else {
    if (!state.browsePath) {
      showError(new Error('请先进入一个目录'));
      return;
    }
    $('output-dir').value = state.browsePath;
  }
  $('browse-modal').hidden = true;
}

/* ---------- 拖入本地文件和文件夹 ---------- */

const dropZone = $('file-drop-zone');
let dragDepth = 0;
const isFileDrag = (event) => Array.from(event.dataTransfer?.types || []).includes('Files');
function clearDropHighlight() {
  dragDepth = 0;
  dropZone.classList.remove('drag-over');
}
// 在其他区域放下文件时也禁止浏览器导航到文件，避免丢失当前任务界面。
window.addEventListener('dragover', (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = dropZone.contains(event.target) ? 'copy' : 'none';
});
window.addEventListener('drop', (event) => {
  if (isFileDrag(event)) event.preventDefault();
  clearDropHighlight();
});
window.addEventListener('dragend', clearDropHighlight);
window.addEventListener('blur', clearDropHighlight);
dropZone.addEventListener('dragenter', (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  dragDepth++;
  dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) clearDropHighlight();
});
dropZone.addEventListener('drop', (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  clearDropHighlight();
  try {
    if (!window.desktopFiles) throw new Error('请在桌面客户端中拖入文件夹，浏览器中请使用浏览添加或粘贴路径。');
    const paths = Array.from(event.dataTransfer.files, (file) => window.desktopFiles.getPath(file));
    if (!paths.length || paths.some((p) => !p)) throw new Error('无法读取拖入内容的本地路径，请从文件资源管理器拖入文件或文件夹。');
    addPaths(paths);
  } catch (err) { showError(err); }
});

/* ---------- 事件绑定 ---------- */

$('btn-add-pasted').addEventListener('click', () => {
  const lines = $('path-input').value.split('\n').map((s) => s.trim()).filter(Boolean);
  if (lines.length === 0) return;
  addPaths(lines);
  $('path-input').value = '';
});
$('btn-clear-files').addEventListener('click', () => {
  state.addedPaths = [];
  renderAddedPaths();
  void rescan();
});
$('btn-browse-add').addEventListener('click', () => openBrowse('add'));
$('btn-browse-output').addEventListener('click', () => openBrowse('output'));
$('btn-browse-close').addEventListener('click', () => { $('browse-modal').hidden = true; });
$('btn-browse-up').addEventListener('click', () => void loadBrowse(state.browseParent ?? ''));
$('btn-browse-confirm').addEventListener('click', confirmBrowse);
$('btn-save-config').addEventListener('click', () => void saveConfig(false));
$('archive-name').addEventListener('input', updateNameTagSelection);
$('btn-start').addEventListener('click', () => void startTask());
$('btn-manual-test').addEventListener('click', () => void manualTest());
$('show-password').addEventListener('change', () => {
  $('password').type = $('show-password').checked ? 'text' : 'password';
});
$('volume-override').addEventListener('input', () => {
  state.selectedVolumeCount = null;
  $('config-save-status').textContent = '设置已修改，开始压缩时自动保存';
  void refreshVolumePlan();
});
$('volume-count').addEventListener('input', () => {
  state.selectedVolumeCount = Number($('volume-count').value);
  void refreshVolumePlan();
});
for (const [id, delta] of [['btn-volume-less', -1], ['btn-volume-more', 1]]) {
  $(id).addEventListener('click', () => {
    const current = Number($('volume-count').value) || 2;
    $('volume-count').value = Math.min(10000, Math.max(2, current + delta));
    $('volume-count').dispatchEvent(new Event('input'));
  });
}
$('btn-volume-auto').addEventListener('click', () => {
  state.selectedVolumeCount = null;
  $('volume-override').value = '';
  void refreshVolumePlan();
});
$('auto-test').addEventListener('change', () => { $('config-save-status').textContent = '设置已修改，开始压缩时自动保存'; });

$('btn-cancel').addEventListener('click', async () => {
  $('btn-cancel').disabled = true;
  try { await api('/api/cancel', {}); }
  catch (err) { showError(err); $('btn-cancel').disabled = false; }
});
$('btn-dismiss-notice').addEventListener('click', () => { $('notice').hidden = true; });
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') $('browse-modal').hidden = true;
});
void init();