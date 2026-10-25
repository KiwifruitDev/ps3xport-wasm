import { Engine } from './engine.js';

const $ = selector => document.querySelector(selector);

const els = {
  status: $('#app-status'),
  unsupported: $('#unsupported'),
  chooseBackup: $('#choose-backup'),
  backupName: $('#backup-name'),
  backupSummary: $('#backup-summary'),
  contentsPanel: $('#contents-panel'),
  indexSelect: $('#index-select'),
  filter: $('#filter'),
  indexSummary: $('#index-summary'),
  fileList: $('#file-list'),
  chooseOut: $('#choose-out'),
  outName: $('#out-name'),
  extractAll: $('#extract-all'),
  extractSelected: $('#extract-selected'),
  chooseContent: $('#choose-content'),
  contentName: $('#content-name'),
  createBackup: $('#create-backup'),
  createHint: $('#create-hint'),
  addContent: $('#add-content'),
  deleteSelected: $('#delete-selected'),
  deleteProtected: $('#delete-protected'),
  deviceId: $('#device-id'),
  openPsid: $('#open-psid'),
  applyIds: $('#apply-ids'),
  progressWrap: $('#progress-wrap'),
  progressFill: $('#progress-fill'),
  progressLabel: $('#progress-label'),
  log: $('#log'),
  clearLog: $('#clear-log'),
};

const state = {
  engine: new Engine(),
  backupDir: null,
  outDir: null,
  contentDir: null,
  indexes: new Map(),
  selectedPath: null,
  busy: false,
};

const MAX_ROWS = 2000;

function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 1024) return `${value} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size.toFixed(size >= 100 ? 0 : size >= 10 ? 1 : 2)} ${units[unit]}`;
}

function log(message, kind = '') {
  const line = document.createElement('span');
  line.className = kind;
  const time = new Date().toLocaleTimeString();
  line.textContent = `${time}  ${message}\n`;
  els.log.append(line);
  els.log.scrollTop = els.log.scrollHeight;
}

function setStatus(text, kind = '') {
  els.status.textContent = text;
  els.status.className = `status ${kind}`.trim();
}

function showUnsupported(message) {
  els.unsupported.hidden = false;
  els.unsupported.textContent = message;
  els.chooseBackup.disabled = true;
  setStatus('Unsupported', 'error');
}

let progressTimer = null;

function startProgress(label) {
  els.progressWrap.hidden = false;
  els.progressFill.classList.add('indeterminate');
  let lastBytes = 0;
  let lastTime = performance.now();
  progressTimer = setInterval(() => {
    const bytes = state.engine.bytesMoved;
    const now = performance.now();
    const rate = (bytes - lastBytes) / Math.max((now - lastTime) / 1000, 0.001);
    lastBytes = bytes;
    lastTime = now;
    els.progressLabel.textContent = `${label} · ${formatBytes(bytes)} at ${formatBytes(rate)}/s`;
  }, 250);
}

function stopProgress() {
  if (progressTimer) clearInterval(progressTimer);
  progressTimer = null;
  els.progressWrap.hidden = true;
  els.progressFill.classList.remove('indeterminate');
}

async function run(label, action) {
  if (state.busy) return undefined;
  state.busy = true;
  updateSelectionState();
  state.engine.resetProgress();
  setStatus(label, 'busy');
  log(label);
  startProgress(label);
  const started = performance.now();
  try {
    const result = await action();
    const seconds = (performance.now() - started) / 1000;
    log(`${label} finished in ${seconds.toFixed(1)}s (${formatBytes(state.engine.bytesMoved)} transferred)`, 'ok');
    setStatus('Ready');
    return result;
  } catch (error) {
    log(`${label} failed: ${error?.message ?? error}`, 'err');
    setStatus('Error', 'error');
    return undefined;
  } finally {
    stopProgress();
    state.busy = false;
    updateSelectionState();
  }
}

async function boot() {
  if (!window.isSecureContext) {
    showUnsupported('This page must be served from https:// or http://localhost (secure context required).');
    return;
  }
  if (!window.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') {
    showUnsupported('Cross-origin isolation is unavailable, so the WebAssembly bridge cannot run. Serve the app with server.mjs (it sends COOP/COEP headers).');
    return;
  }
  if (!('showDirectoryPicker' in window)) {
    showUnsupported('This browser does not support the File System Access API. Use a current version of Chrome or Edge.');
    return;
  }
  try {
    await state.engine.start();
    log('WebAssembly core ready (ps3xport, bundled keys.conf)', 'ok');
    setStatus('Ready');
  } catch (error) {
    showUnsupported(`Could not start the WebAssembly core: ${error?.message ?? error}`);
  }
}

function renderSummary() {
  const entry = state.indexes.get(els.indexSelect.value);
  if (!entry) {
    els.indexSummary.textContent = 'No index loaded.';
    return;
  }
  const data = entry.data;
  const rows = [
    ['Backup ID', data.id],
    ['Archive type', `${data.archiveType} (${data.archiveType === 5 ? 'normal' : 'copy-protected'})`],
    ['Files', `${data.files.length.toLocaleString()} (${formatBytes(data.totalFileSizes)} total)`],
    ['Directories', data.dirs.length.toLocaleString()],
  ];
  if (data.archiveType === 5) rows.push(['OpenPSID', data.psid]);
  if (data.archive2Size) rows.push(['Copy-protected size', formatBytes(data.archive2Size)]);

  const dl = document.createElement('dl');
  for (const [term, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dl.append(dt, dd);
  }
  els.indexSummary.replaceChildren(dl);
}

function renderFiles() {
  const entry = state.indexes.get(els.indexSelect.value);
  const filter = els.filter.value.trim().toLowerCase();
  const all = entry?.data.files ?? [];
  const matching = filter ? all.filter(file => file.path.toLowerCase().includes(filter)) : all;
  const shown = matching.slice(0, MAX_ROWS);

  els.fileList.replaceChildren();
  if (shown.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 3;
    td.className = 'muted';
    td.textContent = all.length === 0 ? 'This index contains no files.' : 'No path matches the filter.';
    tr.append(td);
    els.fileList.append(tr);
  } else {
    for (const file of shown) {
      const tr = document.createElement('tr');
      tr.dataset.path = file.path;
      if (file.path === state.selectedPath) tr.classList.add('selected');
      const path = document.createElement('td');
      path.textContent = file.path;
      const size = document.createElement('td');
      size.className = 'num';
      size.textContent = formatBytes(file.size);
      const mode = document.createElement('td');
      mode.className = 'num';
      mode.textContent = `0${(file.mode & 0o7777).toString(8)}`;
      tr.append(path, size, mode);
      els.fileList.append(tr);
    }
  }

  if (matching.length > shown.length) {
    log(`Showing the first ${MAX_ROWS.toLocaleString()} of ${matching.length.toLocaleString()} matching files. Refine the filter to see the rest.`, 'warn');
  }
  updateSelectionState();
}

function updateSelectionState() {
  const hasSelection = Boolean(state.selectedPath);
  const hasBackup = state.indexes.size > 0;
  els.extractSelected.disabled = !hasSelection || state.busy;
  els.deleteSelected.disabled = !hasSelection || state.busy;
  els.extractAll.disabled = !state.outDir || !hasBackup || state.busy;
  els.addContent.disabled = !state.contentDir || !state.backupDir || state.busy;
  els.createBackup.disabled = !state.contentDir || !state.outDir || state.busy;
  els.deleteProtected.disabled = !state.backupDir || state.busy;
  els.createHint.hidden = !els.createBackup.disabled;
}

async function loadIndex(prefix, { quiet = false } = {}) {
  const path = `/px/backup/${prefix}.dat`;
  const data = await (quiet
    ? state.engine.rpc('listIndex', { path })
    : run(`Reading ${prefix}.dat`, () => state.engine.rpc('listIndex', { path })));
  if (!data) return;
  state.indexes.set(prefix, { data });
  if (!quiet) {
    state.selectedPath = null;
    renderSummary();
    renderFiles();
    log(`${prefix}.dat: ${data.files.length} files, ${data.dirs.length} directories, ${formatBytes(data.totalFileSizes)}`, 'ok');
  }
}

async function scanBackup() {
  const handle = state.backupDir;
  if (!handle) return;

  const files = [];
  for await (const [name, entry] of handle.entries()) {
    if (entry.kind === 'file') files.push(name);
  }
  files.sort();

  const indexFiles = files.filter(name => /^archive2?\.dat$/.test(name));
  const segments = files.filter(name => /^archive2?_\d+\.dat$/.test(name));

  els.backupSummary.hidden = false;
  els.backupSummary.textContent =
    `${files.length} files · ${indexFiles.join(', ') || 'no index found'} · ${segments.length} data segments`;

  if (!files.includes('archive.dat')) {
    log('This folder has no archive.dat; it does not look like a PS3 backup directory.', 'err');
    return;
  }

  state.indexes.clear();
  els.indexSelect.replaceChildren();
  for (const name of indexFiles) {
    const prefix = name.replace(/\.dat$/, '');
    const option = document.createElement('option');
    option.value = prefix;
    option.textContent = name;
    els.indexSelect.append(option);
  }

  await loadIndex('archive');
  els.contentsPanel.hidden = false;

  if (files.includes('archive2.dat')) {
    const probe = await state.engine.rpc('probe', { path: '/px/backup/archive2.dat' }).catch(() => null);
    if (probe?.encryptionType === 0x30) {
      log('archive2.dat holds copy-protected content. Provide the console Device ID in the advanced section to open it.', 'warn');
    }
    els.indexSelect.value = 'archive';
  }
  updateSelectionState();
}

async function chooseBackup() {
  try {
    const handle = await window.showDirectoryPicker({ id: 'ps3export-backup', mode: 'readwrite' });
    state.backupDir = handle;
    els.backupName.textContent = handle.name;
    await state.engine.setRoot('backup', handle);
    await scanBackup();
  } catch (error) {
    if (error?.name !== 'AbortError') log(`Could not open backup folder: ${error?.message ?? error}`, 'err');
  }
}

async function chooseOutput() {
  try {
    const handle = await window.showDirectoryPicker({ id: 'ps3export-output', mode: 'readwrite' });
    state.outDir = handle;
    els.outName.textContent = handle.name;
    await state.engine.setRoot('out', handle);
    updateSelectionState();
  } catch (error) {
    if (error?.name !== 'AbortError') log(`Could not open output folder: ${error?.message ?? error}`, 'err');
  }
}

async function chooseContent() {
  try {
    const handle = await window.showDirectoryPicker({ id: 'ps3export-content', mode: 'read' });
    state.contentDir = handle;
    els.contentName.textContent = handle.name;
    await state.engine.setRoot('content', handle);
    updateSelectionState();
  } catch (error) {
    if (error?.name !== 'AbortError') log(`Could not open content folder: ${error?.message ?? error}`, 'err');
  }
}

async function extractAll() {
  const prefix = els.indexSelect.value || 'archive';
  const result = await run(`Extracting ${prefix} contents`, () =>
    state.engine.rpc('extractAll', { dir: '/px/backup', prefix, outdir: '/px/out' }));
  if (result !== undefined) log('Extraction complete.', 'ok');
}

async function extractSelected() {
  const prefix = els.indexSelect.value || 'archive';
  const filename = state.selectedPath;
  if (!filename) return;
  const result = await run(`Extracting ${filename}`, () =>
    state.engine.rpc('extractFile', {
      dir: '/px/backup',
      prefix,
      filename,
      out: `/px/out${filename}`,
    }));
  if (result !== undefined) log(`Extracted to the output folder at ${filename}`, 'ok');
}

async function createBackup() {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 12);
  const target = `/px/out/${stamp}`;
  const result = await run(`Creating backup ${stamp}`, () =>
    state.engine.rpc('createBackup', { dir: target, content: '/px/content', protectedContent: '-' }));
  if (result !== undefined) log(`Created ${stamp} in the output folder.`, 'ok');
}

async function addContent() {
  const result = await run('Adding content folder to the backup', () =>
    state.engine.rpc('add', { dir: '/px/backup', content: '/px/content', protectedContent: false }));
  if (result !== undefined) {
    log('Content added. Reloading index.', 'ok');
    await scanBackup();
  }
}

async function deleteSelected() {
  const filename = state.selectedPath;
  if (!filename) return;
  const result = await run(`Removing ${filename} from the index`, () =>
    state.engine.rpc('deleteFile', { dir: '/px/backup', filename }));
  if (result !== undefined) {
    state.selectedPath = null;
    await loadIndex(els.indexSelect.value || 'archive', { quiet: true });
    renderSummary();
    renderFiles();
  }
}

async function deleteProtected() {
  const result = await run('Clearing the copy-protected reference', () =>
    state.engine.rpc('deleteProtected', { dir: '/px/backup' }));
  if (result !== undefined) {
    await loadIndex('archive', { quiet: true });
    renderSummary();
    renderFiles();
  }
}

async function applyIds() {
  const deviceId = els.deviceId.value.trim();
  const psid = els.openPsid.value.trim();
  const hex = /^[0-9a-fA-F]{32}$/;

  if (deviceId && !hex.test(deviceId)) {
    log('Device ID must be exactly 32 hex characters.', 'err');
    return;
  }
  if (psid && !hex.test(psid)) {
    log('OpenPSID must be exactly 32 hex characters.', 'err');
    return;
  }

  await run('Applying console keys', async () => {
    await state.engine.rpc('setDeviceId', { hex: deviceId });
    await state.engine.rpc('setOpenPsid', { hex: psid });
  });

  if (deviceId && state.backupDir) {
    const loaded = await run('Opening archive2.dat', () =>
      state.engine.rpc('listIndex', { path: '/px/backup/archive2.dat' }))
      .catch(() => undefined);
    if (loaded) {
      state.indexes.set('archive2', { data: loaded });
      if (![...els.indexSelect.options].some(option => option.value === 'archive2')) {
        const option = document.createElement('option');
        option.value = 'archive2';
        option.textContent = 'archive2.dat';
        els.indexSelect.append(option);
      }
      log(`archive2.dat: ${loaded.files.length} copy-protected files.`, 'ok');
    }
  }
}

els.chooseBackup.addEventListener('click', chooseBackup);
els.chooseOut.addEventListener('click', chooseOutput);
els.chooseContent.addEventListener('click', chooseContent);
els.extractAll.addEventListener('click', extractAll);
els.extractSelected.addEventListener('click', extractSelected);
els.createBackup.addEventListener('click', createBackup);
els.addContent.addEventListener('click', addContent);
els.deleteSelected.addEventListener('click', deleteSelected);
els.deleteProtected.addEventListener('click', deleteProtected);
els.applyIds.addEventListener('click', applyIds);
els.clearLog.addEventListener('click', () => els.log.replaceChildren());

els.filter.addEventListener('input', renderFiles);

els.indexSelect.addEventListener('change', () => {
  state.selectedPath = null;
  renderSummary();
  renderFiles();
});

els.fileList.addEventListener('click', event => {
  const row = event.target.closest('tr[data-path]');
  if (!row) return;
  state.selectedPath = row.dataset.path;
  for (const other of els.fileList.querySelectorAll('tr.selected')) other.classList.remove('selected');
  row.classList.add('selected');
  updateSelectionState();
});

boot();
