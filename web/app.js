// ps3export web panel.
//
// The page keeps a working copy of the backup contents in memory (a Vfs tree)
// and only streams bytes when a file is opened, zipped or written back. The
// WebAssembly core still does all archive work; this file drives it.

import { Engine } from './engine.js';
import { Vfs, MemoryHost } from './vfs.js';
import { buildZip, readZip } from './zip.js';
import * as ui from './ui.js';

const MAX_ROWS = 1500;
const EDIT_LIMIT = 8 * 1024 * 1024;
const COPY_CHUNK = 4 * 1024 * 1024;
const SETTINGS_KEY = 'ps3export.settings.v1';

const $ = selector => document.querySelector(selector);

const el = {
  status: $('#app-status'),
  open: $('#open-button'),
  back: $('#nav-back'),
  forward: $('#nav-forward'),
  up: $('#nav-up'),
  home: $('#nav-home'),
  crumbs: $('#crumbs'),
  pathInput: $('#path-input'),
  pathEdit: $('#path-edit'),
  download: $('#download-button'),
  write: $('#write-button'),
  browser: $('#browser'),
  browserStatus: $('#browser-status'),
  browserUsage: $('#browser-usage'),
  emptyState: $('#empty-state'),
  emptyOpen: $('#empty-open'),
  emptyZip: $('#empty-zip'),
  dropOverlay: $('#drop-overlay'),
  summary: $('#summary'),
  details: $('#details-button'),
  log: $('#log'),
  clearLog: $('#clear-log'),
  editor: $('#editor-dialog'),
  editorForm: $('#editor-form'),
  editorTitle: $('#editor-title'),
  editorPath: $('#editor-path'),
  editorMeta: $('#editor-meta'),
  editorText: $('#editor-text'),
  editorHint: $('#editor-hint'),
  editorCancel: $('#editor-cancel'),
  fileInput: $('#file-input'),
  folderInput: $('#folder-input'),
  zipInput: $('#zip-input'),
  replaceInput: $('#replace-input'),
};

const state = {
  engine: null,
  scratch: new Vfs(),
  tree: new Vfs(),
  source: null,
  writeTarget: null,
  cwd: '/',
  history: ['/'],
  historyIndex: 0,
  selected: null,
  busy: false,
  settings: loadSettings(),
  dirty: new Set(),
  stats: { files: 0, dirs: 0, bytes: 0 },
  details: null,
  scratchSeq: 0,
  editorPath: null,
  editorOriginal: '',
};

/* ------------------------------------------------------------------ utils */

function loadSettings() {
  const defaults = { advanced: false, deviceId: '', openPsid: '' };
  try {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}');
    return { ...defaults, ...stored };
  } catch {
    return defaults;
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  } catch {
    // storage may be disabled; settings then only last for this session
  }
}

function setStatus(text, kind = '') {
  el.status.textContent = text;
  el.status.className = `status ${kind}`.trim();
}

function log(message, kind = '') {
  const line = document.createElement('span');
  line.className = kind;
  const time = new Date().toLocaleTimeString();
  line.textContent = `${time}  ${message}`;
  el.log.append(line);
  el.log.scrollTop = el.log.scrollHeight;
}

const bytes = ui.formatBytes;

function sanitizeName(name) {
  return name.replace(/[\\/:*?"<>|]/g, '').trim();
}

function nameProblem(name, parent = state.cwd) {
  if (!name) return 'Enter a name.';
  if (name === '.' || name === '..') return 'That name is reserved.';
  if (/[\\:*?"<>|]/.test(name)) return 'Names cannot contain \\ : * ? " < > |.';
  const target = `${parent}/${name}`.replace(/\/+/g, '/');
  if (state.tree.has(target)) return 'Something with that name already exists here.';
  return null;
}

/* --------------------------------------------------------------- progress */

function createProgress(title, { cancellable = false } = {}) {
  const dialog = ui.progressDialog({
    title,
    cancellable,
  });
  state.engine.resetProgress();

  const controller = {
    ...dialog,
    stepText: '',
    customDetail: null,
    setStep(text) {
      this.stepText = text ?? '';
      this.customDetail = null;
      dialog.setStep(text);
    },
    setDetail(text) {
      this.customDetail = text ?? null;
      dialog.setDetail(text);
    },
    setFraction(value) {
      dialog.setFraction(value);
    },
    get cancelled() {
      return dialog.cancelled;
    },
    close() {
      clearInterval(timer);
      dialog.close();
    },
  };

  let lastBytes = 0;
  let lastTime = performance.now();
  const timer = setInterval(() => {
    if (controller.customDetail) return;
    const moved = state.engine.bytesMoved;
    const now = performance.now();
    const rate = (moved - lastBytes) / Math.max((now - lastTime) / 1000, 0.001);
    lastBytes = moved;
    lastTime = now;
    dialog.setDetail(`${bytes(moved)} moved at ${bytes(rate)}/s`);
  }, 220);

  return controller;
}

const noProgress = {
  stepText: '',
  cancelled: false,
  setStep() {},
  setDetail() {},
  setFraction() {},
  close() {},
};

async function run(label, action, { cancellable = false } = {}) {
  if (state.busy) {
    ui.toast('Another operation is still running.', { kind: 'warn' });
    return undefined;
  }
  state.busy = true;
  updateControls();
  log(label);
  setStatus(label, 'busy');
  const progress = createProgress(label, { cancellable });
  try {
    const value = await action(progress);
    log(`${label} finished.`, 'ok');
    setStatus('Ready');
    return value === undefined ? true : value;
  } catch (error) {
    const message = error?.message ?? String(error);
    if (error?.name === 'AbortError') {
      log(`${label} cancelled.`, 'warn');
      setStatus('Ready');
      return undefined;
    }
    log(`${label} failed: ${message}`, 'err');
    ui.toast(message, { title: label, kind: 'err', timeout: 12000 });
    setStatus('Error', 'error');
    return undefined;
  } finally {
    progress.close();
    state.busy = false;
    updateControls();
  }
}

/* ------------------------------------------------------------- navigation */

function currentLabel() {
  return state.source?.label ?? 'Backup';
}

function navigate(path, { push = true } = {}) {
  const target = path === '/' ? '/' : path.replace(/\/+$/, '');
  if (!state.tree.has(target)) {
    ui.toast(`"${target}" is not part of this backup.`, { kind: 'warn' });
    return;
  }
  const node = state.tree.get(target);
  if (node.type !== 'dir') {
    openEditor(target);
    return;
  }
  state.cwd = target;
  state.selected = null;
  hidePathInput();
  if (push) {
    state.history = state.history.slice(0, state.historyIndex + 1);
    if (state.history[state.history.length - 1] !== target) state.history.push(target);
    state.historyIndex = state.history.length - 1;
  }
  render();
}

function goBack() {
  if (state.historyIndex <= 0) return;
  state.historyIndex--;
  navigate(state.history[state.historyIndex], { push: false });
}

function goForward() {
  if (state.historyIndex >= state.history.length - 1) return;
  state.historyIndex++;
  navigate(state.history[state.historyIndex], { push: false });
}

function goUp() {
  if (state.cwd === '/') return;
  const parent = state.cwd.slice(0, state.cwd.lastIndexOf('/')) || '/';
  navigate(parent);
}

function resetHistory() {
  state.history = [state.cwd];
  state.historyIndex = 0;
}

function renderCrumbs() {
  el.crumbs.replaceChildren();
  const root = document.createElement('button');
  root.type = 'button';
  root.className = `crumb root ${state.cwd === '/' ? 'current' : ''}`.trim();
  root.innerHTML = `<svg><use href="#i-folder"/></svg><span>${ui.escapeHtml(currentLabel())}</span>`;
  root.addEventListener('click', () => navigate('/'));
  el.crumbs.append(root);

  if (state.cwd === '/') return;
  const segments = state.cwd.slice(1).split('/');
  let accumulated = '';
  segments.forEach((segment, index) => {
    accumulated += `/${segment}`;
    const separator = document.createElement('span');
    separator.className = 'crumb-sep';
    separator.textContent = '›';
    el.crumbs.append(separator);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = `crumb ${index === segments.length - 1 ? 'current' : ''}`.trim();
    button.textContent = segment;
    const target = accumulated;
    button.addEventListener('click', () => navigate(target));
    el.crumbs.append(button);
  });
}

function showPathInput() {
  el.crumbs.hidden = true;
  el.pathInput.hidden = false;
  el.pathInput.value = state.cwd;
  el.pathInput.focus();
  el.pathInput.select();
}

function hidePathInput() {
  el.pathInput.hidden = true;
  el.crumbs.hidden = false;
}

/* ---------------------------------------------------------------- rendering */

function recount() {
  state.stats = state.tree.stats();
}

function render() {
  if (!state.source) {
    el.browser.replaceChildren();
    el.browserStatus.textContent = 'No backup open';
    el.browserUsage.textContent = '';
    el.crumbs.replaceChildren();
    hidePathInput();
    renderSummary();
    updateControls();
    return;
  }

  let entries = [];
  try {
    entries = state.tree.list(state.cwd);
  } catch {
    state.cwd = '/';
    entries = state.tree.list('/');
  }

  el.browser.replaceChildren();
  if (state.cwd !== '/') {
    el.browser.append(buildParentRow());
  }

  const shown = entries.slice(0, MAX_ROWS);
  for (const entry of shown) el.browser.append(buildRow(entry));

  if (entries.length > shown.length) {
    const note = document.createElement('div');
    note.className = 'explorer-row';
    note.style.cursor = 'default';
    note.innerHTML = `<span class="name"><span class="label muted">Showing the first ${shown.length.toLocaleString()} of ${entries.length.toLocaleString()} entries — open a subfolder or use the path bar.</span></span>`;
    el.browser.append(note);
  }

  const folders = entries.filter(entry => entry.type === 'dir').length;
  el.browserStatus.textContent = entries.length === 0
    ? 'This folder is empty'
    : `${folders} folder${folders === 1 ? '' : 's'} · ${entries.length - folders} file${entries.length - folders === 1 ? '' : 's'}`;
  el.browserUsage.textContent = state.dirty.size
    ? `${state.dirty.size} unsaved change${state.dirty.size === 1 ? '' : 's'}`
    : `${state.stats.files.toLocaleString()} files · ${bytes(state.stats.bytes)}`;
  renderCrumbs();
  renderSummary();
  updateControls();
}

function buildParentRow() {
  const row = document.createElement('div');
  row.className = 'explorer-row folder';
  row.dataset.parent = '1';
  row.innerHTML = `<span class="name"><svg><use href="#i-up"/></svg><span class="label muted">..</span></span><span class="size"></span><span class="mode"></span><span class="date"></span>`;
  row.addEventListener('dblclick', goUp);
  row.addEventListener('click', () => {
    select(null);
    row.classList.add('selected');
  });
  return row;
}

function buildRow(entry) {
  const row = document.createElement('div');
  row.className = `explorer-row ${entry.type === 'dir' ? 'folder' : 'file'}`;
  row.dataset.path = entry.path;
  row.dataset.type = entry.type;
  if (entry.path === state.selected) row.classList.add('selected');

  const locked = entry.type === 'file' && entry.node.content?.kind === 'archive' && entry.node.content.prefix !== 'archive';
  const badges = [];
  if (state.dirty.has(entry.path)) badges.push('<span class="badge dirty">edited</span>');
  if (locked) badges.push('<span class="badge locked">protected</span>');

  const name = document.createElement('span');
  name.className = 'name';
  name.innerHTML = `<svg><use href="#${entry.type === 'dir' ? 'i-folder' : 'i-file'}"/></svg><span class="label"></span>${badges.join('')}`;
  name.querySelector('.label').textContent = entry.name;

  const size = document.createElement('span');
  size.className = 'size';
  size.textContent = entry.type === 'file' ? bytes(entry.size) : '—';

  const mode = document.createElement('span');
  mode.className = 'mode';
  mode.textContent = `0${(entry.mode & 0o7777).toString(8)}`;

  const date = document.createElement('span');
  date.className = 'date';
  date.textContent = entry.mtime ? ui.formatDate(entry.mtime) : '—';

  row.append(name, size, mode, date);
  return row;
}

function renderSummary() {
  el.summary.replaceChildren();
  if (!state.source) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Nothing loaded.';
    el.summary.append(empty);
    return;
  }
  const rows = [
    ['Source', `${state.source.kind === 'zip' ? 'Zip' : 'Folder'} · ${state.source.label}`],
    ['Backup ID', state.details?.id ?? '—', true],
    ['Layout', state.details?.layout ?? '—'],
    ['Files', `${state.stats.files.toLocaleString()} (${bytes(state.stats.bytes)})`],
    ['Folders', state.stats.dirs.toLocaleString()],
  ];
  if (state.dirty.size) rows.push(['Edited', `${state.dirty.size.toLocaleString()} file${state.dirty.size === 1 ? '' : 's'}`]);
  for (const [term, value, mono] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.textContent = value;
    if (mono) dd.className = 'mono';
    el.summary.append(dt, dd);
  }
}

const MENU_RULES = {
  open: () => true,
  'open-zip': () => true,
  'create-backup': () => true,
  'replace-zip': () => Boolean(state.source),
  'replace-folder': () => Boolean(state.source),
  'download-zip': () => Boolean(state.source) && state.stats.files > 0,
  write: () => Boolean(state.source),
  close: () => Boolean(state.source),
  'new-file': () => Boolean(state.source),
  'new-folder': () => Boolean(state.source),
  'import-files': () => Boolean(state.source),
  'import-folder': () => Boolean(state.source),
  rename: () => Boolean(state.source && state.selected),
  delete: () => Boolean(state.source && state.selected),
  refresh: () => Boolean(state.source?.handle),
  'show-details': () => Boolean(state.source),
  settings: () => true,
  about: () => true,
  shortcuts: () => true,
};

function updateControls() {
  const has = Boolean(state.source);
  const busy = state.busy;
  el.back.disabled = busy || state.historyIndex <= 0;
  el.forward.disabled = busy || state.historyIndex >= state.history.length - 1;
  el.up.disabled = busy || !has || state.cwd === '/';
  el.home.disabled = busy || !has;
  el.download.disabled = busy || !has || state.stats.files === 0;
  el.write.disabled = busy || !has;
  el.emptyState.hidden = has;
  el.open.disabled = busy;
  el.pathEdit.disabled = busy || !has;
  el.write.title = state.dirty.size
    ? `Write ${state.dirty.size} edited file(s) back to the device (Ctrl+S)`
    : 'Write the working copy back to the device (Ctrl+S)';

  for (const button of document.querySelectorAll('.menu-panel [data-cmd]')) {
    const rule = MENU_RULES[button.dataset.cmd];
    button.disabled = busy || (rule ? !rule() : false);
  }
}

function select(path) {
  state.selected = path ?? null;
  for (const row of el.browser.querySelectorAll('.explorer-row.selected')) row.classList.remove('selected');
  if (path) {
    const row = [...el.browser.querySelectorAll('.explorer-row')].find(node => node.dataset.path === path);
    row?.classList.add('selected');
  }
  updateControls();
}

/* ------------------------------------------------------------- file access */

async function resolveHandleFile(dir, rel) {
  const segments = String(rel).split('/').filter(Boolean);
  const name = segments.pop();
  let current = dir;
  for (const segment of segments) current = await current.getDirectoryHandle(segment);
  return await current.getFileHandle(name);
}

async function materialize(node) {
  const content = node?.content;
  if (!content) return new Blob([]);
  if (content.kind === 'blob') return content.blob;
  if (content.kind === 'zip') return await content.entry.getBlob();
  if (content.kind === 'handle') {
    const handle = await resolveHandleFile(content.dir, content.rel);
    return await handle.getFile();
  }
  if (content.kind === 'archive') {
    if (!state.source?.root) throw new Error('The source archive is no longer mounted.');
    const scratchPath = `/extract-${++state.scratchSeq}`;
    await state.engine.rpc('extractFile', {
      dir: `/px/${state.source.root}`,
      prefix: content.prefix,
      filename: content.srcPath,
      out: `/px/scratch${scratchPath}`,
    });
    const blob = state.scratch.takeBlob(scratchPath);
    if (!blob) throw new Error(`Could not read ${content.srcPath} from the archive.`);
    return blob;
  }
  return new Blob([]);
}

async function readText(path) {
  const node = state.tree.get(path);
  const blob = await materialize(node);
  const buffer = new Uint8Array(await blob.arrayBuffer());
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  if (sample.includes(0)) return { binary: true, size: blob.size };
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return { text: text.replace(/^\uFEFF/, ''), size: blob.size };
  } catch {
    return { binary: true, size: blob.size };
  }
}

async function downloadNode(path) {
  const node = state.tree.get(path);
  if (!node || node.type !== 'file') return;
  await run(`Reading ${path}`, async () => {
    const blob = await materialize(node);
    triggerDownload(blob, path.split('/').pop() || 'download');
  });
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 120000);
}

/* ------------------------------------------------------------------ editor */

async function fetchEditorContent(path) {
  const node = state.tree.get(path);
  if (node.size > EDIT_LIMIT) return { tooLarge: true, size: node.size };
  return await run(`Opening ${path}`, async () => readText(path));
}

async function openEditor(path) {
  const node = state.tree.get(path);
  if (!node) return;
  if (node.type === 'dir') {
    navigate(path);
    return;
  }
  const opened = await fetchEditorContent(path);
  if (!opened) return;
  if (opened.binary) {
    await ui.openDialog({
      title: 'Binary file',
      subtitle: path,
      body: '<p class="muted">This file does not look like UTF-8 text, so the built-in editor cannot show it. You can still download it or replace it by importing a new file.</p>',
      actions: [
        { label: 'Close', value: null, kind: 'secondary' },
        {
          label: 'Download',
          kind: 'primary',
          onClick: ({ close }) => {
            close(null);
            downloadNode(path);
          },
        },
      ],
    });
    return;
  }
  if (opened.tooLarge) {
    await ui.openDialog({
      title: 'File is too large to edit',
      subtitle: path,
      body: `<p class="muted">This file is ${bytes(opened.size)}. The editor is limited to ${bytes(EDIT_LIMIT)} to keep the page responsive.</p>`,
      actions: [
        { label: 'Close', value: null, kind: 'secondary' },
        { label: 'Download', kind: 'primary', onClick: ({ close }) => { close(null); downloadNode(path); } },
      ],
    });
    return;
  }

  state.editorPath = path;
  state.editorOriginal = opened.text;
  el.editorTitle.textContent = path.split('/').pop();
  el.editorPath.textContent = path;
  el.editorText.value = opened.text;
  updateEditorMeta();
  if (!el.editor.open) el.editor.showModal();
  el.editorText.focus();
  el.editorText.setSelectionRange(0, 0);
}

function updateEditorMeta() {
  const value = el.editorText.value;
  const lines = value ? value.split('\n').length : 1;
  el.editorMeta.textContent = `${lines.toLocaleString()} lines · ${value.length.toLocaleString()} characters`;
  el.editorHint.textContent = value === state.editorOriginal
    ? 'Ctrl+S saves to the working copy'
    : 'Unsaved changes — Ctrl+S to apply';
}

function saveEditor() {
  const path = state.editorPath;
  if (!path) return;
  const value = el.editorText.value;
  if (value !== state.editorOriginal) {
    const node = state.tree.get(path);
    state.tree.putBlob(path, new Blob([value], { type: 'text/plain' }), {
      mtime: new Date(),
      mode: node?.mode,
    });
    state.dirty.add(path);
    recount();
    log(`${path} updated in the working copy (${bytes(value.length)}).`, 'ok');
    ui.toast(`${path.split('/').pop()} saved to the working copy.`, { kind: 'ok', title: 'Saved' });
  }
  state.editorOriginal = value;
  el.editor.close();
  render();
}

/* ------------------------------------------------------------ load a backup */

async function listFolderNames(handle) {
  const names = [];
  for await (const [name, entry] of handle.entries()) {
    names.push({ name, kind: entry.kind });
  }
  return names;
}

function buildTreeFromIndexes(indexes) {
  const vfs = new Vfs();
  for (const index of indexes) {
    for (const dir of index.dirs) {
      if (dir.path) vfs.ensureDir(dir.path);
    }
    for (const file of index.files) {
      const stamp = file.mtime ? new Date(file.mtime * 1000) : new Date();
      vfs.put(file.path, {
        size: file.size,
        mtime: stamp,
        mode: file.mode || 0o644,
        content: { kind: 'archive', prefix: index.prefix, srcPath: file.path },
      });
    }
  }
  return vfs;
}

async function applyCredentials() {
  if (!state.settings.advanced) return;
  if (state.settings.deviceId) {
    await state.engine.rpc('setDeviceId', { hex: state.settings.deviceId }).catch(error => {
      log(`Device ID rejected: ${error.message}`, 'warn');
    });
  }
  if (state.settings.openPsid) {
    await state.engine.rpc('setOpenPsid', { hex: state.settings.openPsid }).catch(error => {
      log(`OpenPSID rejected: ${error.message}`, 'warn');
    });
  }
}

/**
 * Reads the index files of a mounted source and rebuilds the working copy.
 * `root` is the pxfs root ("usb" for a folder, "zip" for an imported zip).
 */
async function loadArchiveSource({
  root, label, kind, handle = null, protectedPresent = false, progress = noProgress,
}) {
  progress.setStep('Reading archive.dat');
  const indexes = [];
  const main = await state.engine.rpc('listIndex', { path: `/px/${root}/archive.dat` });
  indexes.push({ prefix: 'archive', ...main });

  let protectedLoaded = false;
  if (protectedPresent) {
    if (!state.settings.advanced) {
      log('archive2.dat holds copy-protected content; it is ignored while advanced mode is off.', 'warn');
    } else if (!state.settings.deviceId) {
      log('archive2.dat needs a Device ID. Add one in Settings → Advanced mode to include it.', 'warn');
    } else {
      progress.setStep('Reading archive2.dat');
      await applyCredentials();
      try {
        const second = await state.engine.rpc('listIndex', { path: `/px/${root}/archive2.dat` });
        indexes.push({ prefix: 'archive2', ...second });
        protectedLoaded = true;
        log(`archive2.dat: ${second.files.length} copy-protected files included.`, 'ok');
      } catch (error) {
        log(`archive2.dat could not be opened: ${error.message}`, 'warn');
      }
    }
  }

  state.tree = buildTreeFromIndexes(indexes);
  state.source = {
    kind, label, root, handle, indexes: indexes.map(index => index.prefix), protectedPresent, protectedLoaded,
  };
  state.details = {
    id: main.id,
    layout: protectedPresent ? (protectedLoaded ? 'Normal + copy-protected' : 'Normal + copy-protected (ignored)') : 'Normal',
    archives: indexes.map(index => ({
      prefix: index.prefix, id: index.id, files: index.files.length, dirs: index.dirs.length, size: index.totalFileSizes,
    })),
  };
  state.dirty.clear();
  state.selected = null;
  state.cwd = '/';
  resetHistory();
  recount();
  log(`Loaded ${label}: ${main.files.length.toLocaleString()} files, ${main.dirs.length.toLocaleString()} folders, ${bytes(main.totalFileSizes)}.`, 'ok');
  render();
}

async function loadBackupFolder(handle, { progress = noProgress, replace = false } = {}) {
  progress.setStep('Scanning the folder');
  const entries = await listFolderNames(handle);
  const hasArchive = entries.some(entry => entry.name === 'archive.dat' && entry.kind === 'file');

  if (!hasArchive) {
    // A common mistake is picking PS3/EXPORT instead of PS3/EXPORT/<timestamp>.
    const candidates = [];
    for (const entry of entries) {
      if (entry.kind !== 'directory') continue;
      const subEntries = await listFolderNames(await handle.getDirectoryHandle(entry.name));
      if (subEntries.some(item => item.name === 'archive.dat' && item.kind === 'file')) {
        candidates.push(await handle.getDirectoryHandle(entry.name));
      }
    }
    if (candidates.length === 1) {
      log(`No archive.dat here; opening the backup in "${candidates[0].name}".`, 'dim');
      await loadBackupFolder(candidates[0], { progress, replace });
      ui.toast(`Opened the backup inside "${candidates[0].name}".`, { kind: 'ok' });
      return;
    }
    if (candidates.length > 1) {
      ui.toast('This folder holds several backups; open the timestamp folder you want instead.', { kind: 'warn', timeout: 9000 });
      return;
    }
  }

  const protectedPresent = entries.some(entry => entry.name === 'archive2.dat' && entry.kind === 'file');

  await state.engine.setRoot('usb', handle);
  if (!replace) state.writeTarget = { handle, name: handle.name };

  if (!hasArchive) {
    await loadContentSource({ handle, label: handle.name, progress });
    ui.toast('This folder has no archive.dat, so its contents were loaded as a content tree instead.', {
      kind: 'warn', title: 'Not a backup folder', timeout: 9000,
    });
    return;
  }

  await loadArchiveSource({
    root: 'usb', label: handle.name, kind: 'folder', handle, protectedPresent, progress,
  });
}

async function loadContentSource({ handle = null, zipEntries = null, label, progress = noProgress }) {
  const vfs = new Vfs();
  let files = 0;
  if (handle) {
    progress.setStep('Reading the folder contents');
    for await (const entry of walkDirectory(handle)) {
      if (entry.kind === 'directory') {
        vfs.ensureDir(entry.path);
        continue;
      }
      files++;
      vfs.put(entry.path, {
        size: entry.size,
        content: { kind: 'handle', dir: handle, rel: entry.path.slice(1) },
        mtime: new Date(),
      });
      if (files % 500 === 0) progress.setDetail(`${files.toLocaleString()} files`);
    }
  } else {
    for (const entry of zipEntries) {
      if (!entry.path) continue;
      if (entry.isDir) {
        vfs.ensureDir(entry.path);
        continue;
      }
      files++;
      vfs.put(entry.path, {
        size: entry.size,
        content: { kind: 'zip', entry, srcPath: entry.path },
        mtime: entry.mtime,
      });
    }
  }

  state.tree = vfs;
  state.source = { kind: handle ? 'folder' : 'zip', label, root: handle ? null : 'zip', handle, indexes: [] };
  state.details = { id: null, layout: 'Content tree (no index)', archives: [] };
  state.dirty.clear();
  state.selected = null;
  state.cwd = '/';
  resetHistory();
  recount();
  log(`Loaded ${label}: ${files.toLocaleString()} files as a content tree.`, 'ok');
  render();
}

async function* walkDirectory(dir, prefix = '') {
  for await (const [name, entry] of dir.entries()) {
    const path = `${prefix}/${name}`;
    if (entry.kind === 'directory') {
      yield { kind: 'directory', path };
      yield* walkDirectory(entry, path);
    } else {
      const file = await entry.getFile();
      yield { kind: 'file', path, size: file.size, handle: entry };
    }
  }
}

async function ensureDiscardSafe() {
  if (!state.source || state.dirty.size === 0) return true;
  return await ui.confirmDialog({
    title: 'Discard unsaved changes',
    message: 'The working copy has edits that were not written to the device.',
    detail: 'They will be lost when the working copy is replaced.',
    confirmLabel: 'Discard and continue',
    danger: true,
  });
}

async function openFolder() {
  if (!window.showDirectoryPicker) {
    ui.toast('This browser does not support picking folders. Use a current Chrome or Edge.', { kind: 'err' });
    return;
  }
  let handle;
  try {
    handle = await window.showDirectoryPicker({ id: 'ps3export-backup', mode: 'readwrite' });
  } catch (error) {
    if (error?.name !== 'AbortError') ui.toast(error.message ?? String(error), { kind: 'err', title: 'Could not open folder' });
    return;
  }
  if (!(await ensureDiscardSafe())) return;
  await run('Opening backup', progress => loadBackupFolder(handle, { progress }));
}

async function openZipFile(file, { replace = false } = {}) {
  if (!file) return;
  await run(`Reading ${file.name}`, async progress => {
    progress.setStep('Reading the zip index');
    const { entries } = await readZip(file);
    const zipVfs = new Vfs();
    let hasArchive = false;
    for (const entry of entries) {
      if (entry.isDir) {
        zipVfs.ensureDir(entry.path);
        continue;
      }
      if (entry.path === 'archive.dat') hasArchive = true;
      zipVfs.put(entry.path, {
        size: entry.size,
        content: { kind: 'zip', entry, srcPath: entry.path },
        mtime: entry.mtime,
      });
    }

    const host = new MemoryHost(zipVfs, { onProgress: () => {} });
    await state.engine.mountMemory('zip', host);
    if (!replace) state.writeTarget = null;

    if (hasArchive) {
      const protectedPresent = entries.some(entry => entry.path === 'archive2.dat' && !entry.isDir);
      await loadArchiveSource({
        root: 'zip', label: file.name, kind: 'zip', protectedPresent, progress,
      });
    } else {
      await loadContentSource({ zipEntries: entries, label: file.name, progress });
    }
    if (!replace && !state.writeTarget) {
      ui.toast('Choose a folder with "Write" when you are ready to save this copy to a device.', { kind: 'info', timeout: 8000 });
    }
  });
}

/* ----------------------------------------------------------------- writing */

async function splitHandle(rootHandle, path, { createParents = true } = {}) {
  const segments = path.split('/').filter(Boolean);
  const name = segments.pop();
  let dir = rootHandle;
  for (const segment of segments) dir = await dir.getDirectoryHandle(segment, { create: createParents });
  return { dir, name };
}

async function writeBlob(rootHandle, path, blob, onBytes) {
  const { dir, name } = await splitHandle(rootHandle, path);
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  for (let offset = 0; offset < blob.size; offset += COPY_CHUNK) {
    const end = Math.min(offset + COPY_CHUNK, blob.size);
    await writable.write(await blob.slice(offset, end).arrayBuffer());
    onBytes?.(end - offset);
  }
  await writable.close();
}

async function copyHandleFile(sourceDir, rel, targetDir, path, onBytes) {
  const source = await resolveHandleFile(sourceDir, rel);
  const file = await source.getFile();
  const { dir, name } = await splitHandle(targetDir, path);
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  for (let offset = 0; offset < file.size; offset += COPY_CHUNK) {
    const end = Math.min(offset + COPY_CHUNK, file.size);
    await writable.write(await file.slice(offset, end).arrayBuffer());
    onBytes?.(end - offset);
  }
  await writable.close();
}

/** Removes every entry of `root` that is not part of the working copy. */
async function pruneHandleTree(root, progress) {
  const removed = [];
  async function walk(dir, prefix) {
    for await (const [name, entry] of dir.entries()) {
      const path = `${prefix}/${name}`;
      if (!state.tree.has(path)) {
        removed.push(path);
        continue;
      }
      const node = state.tree.get(path);
      if (node.type === 'dir' && entry.kind === 'directory') await walk(entry, path);
    }
  }
  await walk(root, '');
  for (const path of removed) {
    const { dir, name } = await splitHandle(root, path, { createParents: false });
    await dir.removeEntry(name, { recursive: true }).catch(() => {});
  }
  if (removed.length) {
    progress.setDetail(`Removed ${removed.length.toLocaleString()} entries that are no longer in the working copy`);
    log(`Pruned ${removed.length} entr${removed.length === 1 ? 'y' : 'ies'} from the staging folder.`, 'dim');
  }
}

function stamps() {
  const now = new Date();
  const pad = value => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
}

function archiveFilePattern(name) {
  return /^archive2?(_\d+)?\.(dat|bak)$/i.test(name);
}

async function writeToDevice() {
  if (!state.source) return;

  let target = state.writeTarget;
  if (!target) {
    try {
      const handle = await window.showDirectoryPicker({ id: 'ps3export-write', mode: 'readwrite' });
      target = { handle, name: handle.name };
      state.writeTarget = target;
      await state.engine.setRoot('usb', handle);
    } catch (error) {
      if (error?.name !== 'AbortError') ui.toast(error.message ?? String(error), { kind: 'err', title: 'No target folder' });
      return;
    }
  }

  const stats = state.stats;
  const dropsProtected = state.source.protectedPresent && !state.source.protectedLoaded;
  const detail = `The new backup is built first and only replaces the old files once it is complete.`;
  const warning = dropsProtected
    ? ' This backup contains copy-protected content (archive2.dat) that advanced mode did not load, so those files will not be part of the rebuilt backup.'
    : '';

  const confirmed = await ui.confirmDialog({
    title: 'Write to device',
    message: `Rebuild the archive from ${stats.files.toLocaleString()} files (${bytes(stats.bytes)}) and replace archive*.dat in "${target.name}"?`,
    detail: detail + warning,
    confirmLabel: 'Write backup',
    danger: true,
  });
  if (!confirmed) return;

  const stamp = stamps();
  const result = await run('Writing backup', async progress => {
    progress.setStep('Creating the staging folder');
    const stageHandle = await target.handle.getDirectoryHandle(`.ps3export-stage-${stamp}`, { create: true });
    const outHandle = await target.handle.getDirectoryHandle(`.ps3export-out-${stamp}`, { create: true });

    try {
      await state.engine.setRoot('stage', stageHandle);
      await state.engine.setRoot('out', outHandle);

      const extracted = new Set();
      if (state.source.root && state.source.indexes.length) {
        progress.setStep('Extracting the archive into the staging folder');
        for (const prefix of state.source.indexes) {
          await state.engine.rpc('extractAll', { dir: `/px/${state.source.root}`, prefix, outdir: '/px/stage' });
          extracted.add(prefix);
        }
      }

      progress.setStep('Applying your changes');
      const total = stats.bytes || 1;
      let copied = 0;
      for (const { path, node } of state.tree.files()) {
        if (progress.cancelled) throw new DOMException('Cancelled', 'AbortError');
        const content = node.content;
        if (!content) continue;
        if (content.kind === 'archive' && extracted.has(content.prefix) && content.srcPath === path) continue;
        if (content.kind === 'zip' && state.source.root === 'zip' && extracted.size && content.srcPath === path) continue;
        if (content.kind === 'blob') {
          await writeBlob(stageHandle, path, content.blob, delta => {
            copied += delta;
            progress.setFraction(Math.min(0.9, copied / total) * 0.5);
          });
        } else if (content.kind === 'handle') {
          await copyHandleFile(content.dir, content.rel, stageHandle, path, delta => {
            copied += delta;
            progress.setFraction(Math.min(0.9, copied / total) * 0.5);
          });
        } else if (content.kind === 'zip') {
          const blob = await content.entry.getBlob();
          await writeBlob(stageHandle, path, blob, delta => {
            copied += delta;
            progress.setFraction(Math.min(0.9, copied / total) * 0.5);
          });
        } else if (content.kind === 'archive') {
          // A renamed file still lives in the archive under its old path.
          const scratch = await materialize(node);
          await writeBlob(stageHandle, path, scratch, delta => {
            copied += delta;
            progress.setFraction(Math.min(0.9, copied / total) * 0.5);
          });
        }
      }

      if (extracted.size) {
        progress.setStep('Removing deleted files');
        await pruneHandleTree(stageHandle, progress);
      }
      // Force a fresh directory tree in the worker: files were written through
      // raw handles, so PXFS must not reuse anything it cached earlier.
      state.engine.host.invalidate('stage');
      await state.engine.mount('stage');

      if (progress.cancelled) throw new DOMException('Cancelled', 'AbortError');

      progress.setStep('Building the new archive');
      progress.setFraction(0.55);
      await state.engine.rpc('createBackup', { dir: '/px/out', content: '/px/stage', protectedContent: '-' });

      progress.setStep('Replacing the files on the device');
      progress.setFraction(0.9);
      const existing = [];
      for await (const [name, entry] of target.handle.entries()) {
        if (entry.kind === 'file' && archiveFilePattern(name)) existing.push(name);
      }
      for (const name of existing) await target.handle.removeEntry(name);

      const built = [];
      for await (const [name, entry] of outHandle.entries()) {
        if (entry.kind === 'file') built.push(name);
      }
      if (!built.includes('archive.dat')) throw new Error('The new archive was not built; the device was not modified.');

      for (const name of built) {
        const handle = await outHandle.getFileHandle(name);
        const file = await handle.getFile();
        const writable = await (await target.handle.getFileHandle(name, { create: true })).createWritable();
        for (let offset = 0; offset < file.size; offset += COPY_CHUNK) {
          const end = Math.min(offset + COPY_CHUNK, file.size);
          await writable.write(await file.slice(offset, end).arrayBuffer());
        }
        await writable.close();
      }
      state.engine.host.invalidate('usb');

      progress.setStep('Cleaning up');
      await target.handle.removeEntry(`.ps3export-stage-${stamp}`, { recursive: true }).catch(() => {});
      await target.handle.removeEntry(`.ps3export-out-${stamp}`, { recursive: true }).catch(() => {});

      state.dirty.clear();
      log(`Wrote ${built.length} archive file${built.length === 1 ? '' : 's'} to ${target.name}.`, 'ok');
      ui.toast(`Backup written to ${target.name}.`, { kind: 'ok', title: 'Saved to device' });
      return true;
    } catch (error) {
      await target.handle.removeEntry(`.ps3export-stage-${stamp}`, { recursive: true }).catch(() => {});
      await target.handle.removeEntry(`.ps3export-out-${stamp}`, { recursive: true }).catch(() => {});
      throw error;
    }
  });

  if (result) {
    await run('Reloading the new backup', progress => loadBackupFolder(target.handle, { progress, replace: true }));
  }
}

/* ------------------------------------------------------------- downloads */

async function downloadZip() {
  if (!state.source) return;
  const total = state.stats.bytes || 1;
  const stem = sanitizeName((state.source.label || 'ps3export').replace(/\.zip$/i, '')) || 'ps3export';
  const name = `${stem}-${stamps()}.zip`;

  await run('Preparing zip', async progress => {
    progress.setStep('Collecting files');
    const entries = [];
    for (const { path, node } of state.tree.files()) {
      entries.push({
        path,
        mtime: node.mtime,
        getBlob: () => materialize(node),
      });
    }
    progress.setStep(`Packing ${entries.length.toLocaleString()} files`);
    const { blob, bytes: size, entries: count } = await buildZip(entries, {
      onProgress: produced => {
        progress.setFraction(Math.min(0.999, produced / total));
        progress.setDetail(`${bytes(produced)} of ${bytes(total)}`);
      },
      shouldCancel: () => progress.cancelled,
    });
    progress.setStep('Starting the download');
    triggerDownload(blob, name);
    log(`Prepared ${count.toLocaleString()} files (${bytes(size)}) as ${name}.`, 'ok');
    return true;
  });
}

/* --------------------------------------------------------------- commands */

async function newFile() {
  const parent = state.cwd;
  const name = await ui.promptDialog({
    title: 'New file',
    subtitle: `In ${parent}`,
    label: 'File name',
    confirmLabel: 'Create file',
    validate: value => nameProblem(value, parent),
  });
  if (!name) return;
  const path = `${parent}/${name}`.replace(/\/+/g, '/');
  state.tree.putBlob(path, new Blob([]), { mtime: new Date() });
  state.dirty.add(path);
  recount();
  render();
  log(`Created ${path}.`, 'ok');
  await openEditor(path);
}

async function newFolder() {
  const parent = state.cwd;
  const name = await ui.promptDialog({
    title: 'New folder',
    subtitle: `In ${parent}`,
    label: 'Folder name',
    confirmLabel: 'Create folder',
    validate: value => nameProblem(value, parent),
  });
  if (!name) return;
  const path = `${parent}/${name}`.replace(/\/+/g, '/');
  state.tree.mkdir(path);
  recount();
  render();
  log(`Created folder ${path}.`, 'ok');
  ui.toast(`Folder "${name}" created in the working copy.`, { kind: 'ok' });
}

async function renameSelected() {
  const path = state.selected;
  if (!path) return;
  const node = state.tree.get(path);
  if (!node) return;
  const current = path.split('/').pop();
  const parent = path.slice(0, path.lastIndexOf('/')) || '/';
  const name = await ui.promptDialog({
    title: 'Rename',
    subtitle: path,
    label: 'New name',
    value: current,
    confirmLabel: 'Rename',
    validate: value => (value === current ? null : nameProblem(value, parent)),
  });
  if (!name || name === current) return;
  state.tree.rename(path, name);
  state.dirty.add(path);
  state.dirty.add(`${parent}/${name}`.replace(/\/+/g, '/'));
  state.selected = `${parent}/${name}`.replace(/\/+/g, '/');
  recount();
  render();
  log(`Renamed ${path} to ${state.selected}.`, 'ok');
}

async function deleteSelected() {
  const path = state.selected;
  if (!path) return;
  const node = state.tree.get(path);
  if (!node) return;
  const isDir = node.type === 'dir';
  const confirmed = await ui.confirmDialog({
    title: isDir ? 'Delete folder' : 'Delete file',
    message: `Remove "${path}" from the working copy?`,
    detail: isDir ? 'Everything inside the folder is removed as well.' : 'The device is only modified when you press Write.',
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!confirmed) return;
  state.tree.remove(path);
  state.dirty.add(path);
  state.selected = null;
  recount();
  render();
  log(`Deleted ${path} from the working copy.`, 'ok');
}

function importFiles(fileList) {
  if (!fileList?.length) return;
  const imported = [];
  for (const file of fileList) {
    const relative = file.webkitRelativePath || file.name;
    // Importing a folder copies its contents into the current directory.
    const segments = relative.split('/').filter(Boolean);
    if (file.webkitRelativePath) segments.shift();
    const path = `${state.cwd}/${segments.join('/')}`.replace(/\/+/g, '/');
    if (state.tree.has(path) && state.tree.get(path).type === 'dir') continue;
    state.tree.putBlob(path, file, { mtime: new Date(file.lastModified || Date.now()) });
    state.dirty.add(path);
    imported.push(path);
  }
  recount();
  render();
  log(`Imported ${imported.length} file${imported.length === 1 ? '' : 's'} into ${state.cwd}.`, 'ok');
  ui.toast(`Imported ${imported.length} file${imported.length === 1 ? '' : 's'}.`, { kind: 'ok' });
  if (imported.length === 1) select(imported[0]);
}

async function closeBackup() {
  if (!(await ensureDiscardSafe())) return;
  state.source = null;
  state.tree = new Vfs();
  state.scratch.clear();
  state.writeTarget = null;
  state.details = null;
  state.dirty.clear();
  state.selected = null;
  state.cwd = '/';
  resetHistory();
  state.stats = { files: 0, dirs: 0, bytes: 0 };
  el.log.replaceChildren();
  log('Closed the working copy.', 'dim');
  render();
}

async function showDetails() {
  if (!state.source) return;
  const rows = [
    ['Source', `${state.source.kind === 'zip' ? 'Zip file' : 'Folder'} — ${state.source.label}`],
    ['Backup ID', state.details?.id ?? '—', true],
    ['Layout', state.details?.layout ?? '—'],
    ['Archives', state.details?.archives.map(a => `${a.prefix}.dat`).join(', ') || 'none'],
    ['Files', state.stats.files.toLocaleString()],
    ['Folders', state.stats.dirs.toLocaleString()],
    ['Content size', bytes(state.stats.bytes)],
    ['Edited', String(state.dirty.size)],
    ['Target', state.writeTarget?.name ?? 'not set (Write asks for a folder)'],
  ];
  const list = document.createElement('dl');
  list.className = 'info-list';
  for (const [term, value, mono] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.textContent = value;
    if (mono) dd.className = 'mono';
    list.append(dt, dd);
  }
  await ui.openDialog({
    title: 'Backup details',
    body: list,
    actions: [{ label: 'Close', value: null, kind: 'primary' }],
  });
}

async function showSettings() {
  const body = document.createElement('div');
  body.className = 'dialog-body';
  body.innerHTML = `
    <div class="switch">
      <input type="checkbox" id="set-advanced">
      <div>
        <strong>Advanced mode</strong>
        <span>Load copy-protected content from <code>archive2.dat</code>. Needs the console's Device ID and is off by default.</span>
      </div>
    </div>
    <div class="field">
      <label for="set-device">Device ID / IDP (32 hex characters)</label>
      <input id="set-device" class="mono" type="text" spellcheck="false" placeholder="00000000000000000000000000000000">
      <span class="hint">Only used to decrypt copy-protected content. It never leaves the page.</span>
    </div>
    <div class="field">
      <label for="set-psid">OpenPSID (32 hex characters, optional)</label>
      <input id="set-psid" class="mono" type="text" spellcheck="false" placeholder="all zeroes">
      <span class="hint">Written into new backups when you create them.</span>
    </div>`;
  const advanced = body.querySelector('#set-advanced');
  const device = body.querySelector('#set-device');
  const psid = body.querySelector('#set-psid');
  advanced.checked = state.settings.advanced;
  device.value = state.settings.deviceId;
  psid.value = state.settings.openPsid;

  const sync = () => {
    device.disabled = !advanced.checked;
    psid.disabled = !advanced.checked;
  };
  advanced.addEventListener('change', sync);
  sync();

  const saved = await ui.openDialog({
    title: 'Settings',
    subtitle: 'Stored in this browser only.',
    body,
    actions: [
      { label: 'Cancel', value: null, kind: 'secondary' },
      { label: 'Save', kind: 'primary', onClick: ({ close }) => {
        const hex = /^[0-9a-fA-F]{32}$/;
        const deviceId = device.value.trim();
        const openPsid = psid.value.trim();
        if (advanced.checked && deviceId && !hex.test(deviceId)) {
          device.focus();
          ui.toast('The Device ID must be exactly 32 hex characters.', { kind: 'err' });
          return false;
        }
        if (advanced.checked && openPsid && !hex.test(openPsid)) {
          psid.focus();
          ui.toast('The OpenPSID must be exactly 32 hex characters.', { kind: 'err' });
          return false;
        }
        close({ advanced: advanced.checked, deviceId, openPsid });
        return false;
      } },
    ],
  });

  if (!saved) return;
  const changed = saved.advanced !== state.settings.advanced
    || saved.deviceId !== state.settings.deviceId
    || saved.openPsid !== state.settings.openPsid;
  state.settings = { ...state.settings, ...saved };
  saveSettings();
  await applyCredentials();
  log('Settings saved.', 'dim');
  if (changed && state.source?.protectedPresent && state.source.handle) {
    ui.toast('Reload the backup (F5) to apply the new advanced-mode setting.', { kind: 'info', timeout: 9000 });
  }
}

async function showShortcuts() {
  const rows = [
    ['Ctrl+O', 'Open a backup folder'],
    ['Ctrl+N', 'New file'],
    ['Ctrl+S', 'Save an edited file / write to the device'],
    ['Ctrl+L', 'Edit the path'],
    ['F2', 'Rename the selection'],
    ['Delete', 'Delete the selection'],
    ['F5', 'Reload from the folder'],
    ['Alt+← / Alt+→', 'Go back / forward'],
    ['Backspace / Home', 'Up one level / backup root'],
    ['Enter', 'Open the selection'],
  ];
  const list = document.createElement('dl');
  list.className = 'info-list';
  for (const [key, what] of rows) {
    const dt = document.createElement('dt');
    dt.innerHTML = `<code>${ui.escapeHtml(key)}</code>`;
    const dd = document.createElement('dd');
    dd.style.textAlign = 'left';
    dd.textContent = what;
    list.append(dt, dd);
  }
  await ui.openDialog({ title: 'Keyboard shortcuts', body: list, actions: [{ label: 'Close', value: null, kind: 'primary' }] });
}

async function showAbout() {
  await ui.openDialog({
    title: 'About ps3export',
    body: `<p class="muted">A local PS3 backup editor. The <a href="https://github.com/kakaroto/ps3xport" target="_blank" rel="noreferrer">ps3xport</a> C core (GPLv3) runs as WebAssembly inside this page, so backups are read and written without uploading anything.</p>
      <p class="muted">Web panel by <a href="https://github.com/KiwifruitDev" target="_blank" rel="noreferrer">KiwifruitDev</a> © 2026, MIT licensed.</p>`,
    actions: [{ label: 'Close', value: null, kind: 'primary' }],
  });
}

async function refreshSource() {
  const handle = state.source?.handle;
  if (!handle) {
    ui.toast('This working copy came from a zip. Re-open it or use "Replace contents" to refresh.', { kind: 'warn' });
    return;
  }
  if (state.dirty.size) {
    const confirmed = await ui.confirmDialog({
      title: 'Reload from folder',
      message: 'Reload the backup and discard the unsaved changes in the working copy?',
      confirmLabel: 'Reload',
      danger: true,
    });
    if (!confirmed) return;
  }
  await run('Reloading backup', progress => loadBackupFolder(handle, { progress, replace: true }));
}

/**
 * Builds a brand new backup from a folder that mirrors the PS3 filesystem.
 * This is the only flow that does not need an existing archive.
 */
async function createBackupFromFolder() {
  const picked = { content: null, output: null };
  const body = document.createElement('div');
  body.style.display = 'grid';
  body.style.gap = '.8rem';
  body.innerHTML = `
    <p class="muted">Build a new backup from a folder that mirrors the PS3 filesystem (<code>dev_hdd0</code>, <code>dev_flash2</code>, …). The archive is written into a timestamped subfolder of the output folder.</p>
    <div class="field">
      <label>Content folder</label>
      <button type="button" class="secondary" id="cb-content">Choose content folder…</button>
      <span class="hint" id="cb-content-name">Not selected</span>
    </div>
    <div class="field">
      <label>Output folder</label>
      <button type="button" class="secondary" id="cb-output">Choose output folder…</button>
      <span class="hint" id="cb-output-name">Not selected</span>
    </div>`;

  const confirmed = await ui.openDialog({
    title: 'Create a new backup',
    body,
    actions: [
      { label: 'Cancel', value: null, kind: 'secondary' },
      {
        label: 'Create backup',
        kind: 'primary',
        onClick: ({ close }) => {
          if (!picked.content || !picked.output) {
            ui.toast('Choose both a content folder and an output folder.', { kind: 'warn' });
            return false;
          }
          close(true);
          return false;
        },
      },
    ],
    onOpen: () => {
      body.querySelector('#cb-content').addEventListener('click', async () => {
        try {
          picked.content = await window.showDirectoryPicker({ id: 'ps3export-content', mode: 'read' });
          body.querySelector('#cb-content-name').textContent = picked.content.name;
        } catch (error) {
          if (error?.name !== 'AbortError') ui.toast(error.message ?? String(error), { kind: 'err' });
        }
      });
      body.querySelector('#cb-output').addEventListener('click', async () => {
        try {
          picked.output = await window.showDirectoryPicker({ id: 'ps3export-output', mode: 'readwrite' });
          body.querySelector('#cb-output-name').textContent = picked.output.name;
        } catch (error) {
          if (error?.name !== 'AbortError') ui.toast(error.message ?? String(error), { kind: 'err' });
        }
      });
    },
  });

  if (!confirmed) return;
  const stamp = stamps();
  const built = await run(`Creating backup ${stamp}`, async progress => {
    progress.setStep('Reading the content folder');
    await state.engine.setRoot('content', picked.content);
    await state.engine.setRoot('out', picked.output);
    progress.setStep('Building the archive');
    await state.engine.rpc('createBackup', {
      dir: `/px/out/${stamp}`,
      content: '/px/content',
      protectedContent: '-',
    });
    log(`Created a new backup in ${picked.output.name}/${stamp}.`, 'ok');
    return true;
  });
  if (built) {
    ui.toast(`New backup written to ${picked.output.name}/${stamp}.`, { kind: 'ok', title: 'Backup created' });
  }
}

async function replaceContents(kind) {
  if (!state.source) return;

  if (kind === 'zip') {
    el.replaceInput.value = '';
    el.replaceInput.click();
    return;
  }

  let handle;
  try {
    handle = await window.showDirectoryPicker({ id: 'ps3export-content', mode: 'readwrite' });
  } catch (error) {
    if (error?.name !== 'AbortError') ui.toast(error.message ?? String(error), { kind: 'err' });
    return;
  }
  if (!(await ensureDiscardSafe())) return;
  await run('Replacing the contents', progress => loadBackupFolder(handle, { progress, replace: true }));
}

/* ---------------------------------------------------------------- commands */

const commands = {
  open: openFolder,
  'open-zip': () => {
    el.zipInput.value = '';
    el.zipInput.click();
  },
  'create-backup': createBackupFromFolder,
  'replace-zip': () => replaceContents('zip'),
  'replace-folder': () => replaceContents('folder'),
  'download-zip': downloadZip,
  write: writeToDevice,
  close: closeBackup,
  'new-file': newFile,
  'new-folder': newFolder,
  rename: renameSelected,
  delete: deleteSelected,
  'import-files': () => {
    el.fileInput.value = '';
    el.fileInput.click();
  },
  'import-folder': () => {
    el.folderInput.value = '';
    el.folderInput.click();
  },
  refresh: refreshSource,
  'show-details': showDetails,
  settings: showSettings,
  about: showAbout,
  shortcuts: showShortcuts,
};

async function handleCommand(name) {
  const action = commands[name];
  if (!action) return;
  try {
    await action();
  } catch (error) {
    ui.toast(error.message ?? String(error), { kind: 'err', title: 'Action failed' });
  }
}

/* ----------------------------------------------------------------- events */

function bindEvents() {
  ui.setupMenus(handleCommand);

  el.open.addEventListener('click', () => handleCommand('open'));
  el.emptyOpen.addEventListener('click', () => handleCommand('open'));
  el.emptyZip.addEventListener('click', () => handleCommand('open-zip'));
  el.back.addEventListener('click', goBack);
  el.forward.addEventListener('click', goForward);
  el.up.addEventListener('click', goUp);
  el.home.addEventListener('click', () => navigate('/'));
  el.download.addEventListener('click', () => handleCommand('download-zip'));
  el.write.addEventListener('click', () => handleCommand('write'));
  el.details.addEventListener('click', () => handleCommand('show-details'));
  el.clearLog.addEventListener('click', () => el.log.replaceChildren());
  el.pathEdit.addEventListener('click', showPathInput);

  el.pathInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      const value = el.pathInput.value;
      hidePathInput();
      navigate(value.startsWith('/') ? value : `${state.cwd}/${value}`.replace(/\/+/g, '/'));
    } else if (event.key === 'Escape') {
      hidePathInput();
      el.browser.focus();
    }
  });
  el.pathInput.addEventListener('blur', hidePathInput);

  el.browser.addEventListener('click', event => {
    if (event.target.closest('[data-parent]')) return;
    const row = event.target.closest('.explorer-row[data-path]');
    select(row ? row.dataset.path : null);
    el.browser.focus({ preventScroll: true });
  });
  el.browser.addEventListener('dblclick', event => {
    if (event.target.closest('[data-parent]')) return;
    const row = event.target.closest('.explorer-row[data-path]');
    if (!row) return;
    const entry = state.tree.get(row.dataset.path);
    if (entry?.type === 'dir') navigate(row.dataset.path);
    else openEditor(row.dataset.path);
  });
  el.browser.addEventListener('contextmenu', event => {
    const row = event.target.closest('.explorer-row[data-path]');
    event.preventDefault();
    if (!row) return;
    select(row.dataset.path);
    const path = row.dataset.path;
    const isDir = state.tree.get(path)?.type === 'dir';
    ui.showContextMenu([
      { label: isDir ? 'Open' : 'Edit', icon: isDir ? 'i-folder' : 'i-pencil', action: () => (isDir ? navigate(path) : openEditor(path)) },
      ...(isDir ? [] : [{ label: 'Download', icon: 'i-download', action: () => downloadNode(path) }]),
      { rule: true },
      { label: 'Rename…', icon: 'i-pencil', action: renameSelected },
      { label: 'Delete', icon: 'i-trash', danger: true, action: deleteSelected },
    ], event.clientX, event.clientY);
  });

  el.browser.addEventListener('keydown', event => {
    if (event.key === 'Enter' && state.selected) {
      const entry = state.tree.get(state.selected);
      event.preventDefault();
      if (entry?.type === 'dir') navigate(state.selected);
      else openEditor(state.selected);
    } else if (event.key === 'Backspace') {
      event.preventDefault();
      goUp();
    } else if (event.key === 'Delete') {
      deleteSelected();
    } else if (event.key === 'F2') {
      renameSelected();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveSelection(event.key === 'ArrowDown' ? 1 : -1);
    }
  });

  el.fileInput.addEventListener('change', () => importFiles(el.fileInput.files));
  el.folderInput.addEventListener('change', () => importFiles(el.folderInput.files));
  el.zipInput.addEventListener('change', async () => {
    const file = el.zipInput.files?.[0];
    if (!file) return;
    if (!(await ensureDiscardSafe())) return;
    openZipFile(file);
  });
  el.replaceInput.addEventListener('change', async () => {
    const file = el.replaceInput.files?.[0];
    if (!file) return;
    const confirmed = await ui.confirmDialog({
      title: 'Replace contents with a zip',
      message: `Replace the working copy with "${file.name}"?`,
      detail: 'Unsaved changes are discarded. The write target stays the same.',
      confirmLabel: 'Replace',
      danger: true,
    });
    if (!confirmed) return;
    openZipFile(file, { replace: true });
  });

  el.editorForm.addEventListener('submit', event => {
    event.preventDefault();
    saveEditor();
  });
  el.editorCancel.addEventListener('click', () => el.editor.close());
  el.editorText.addEventListener('input', updateEditorMeta);
  el.editorText.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key === 's') {
      event.preventDefault();
      saveEditor();
    } else if (event.key === 'Tab') {
      event.preventDefault();
      const start = el.editorText.selectionStart;
      const end = el.editorText.selectionEnd;
      const value = el.editorText.value;
      el.editorText.value = `${value.slice(0, start)}  ${value.slice(end)}`;
      el.editorText.selectionStart = el.editorText.selectionEnd = start + 2;
      updateEditorMeta();
    }
  });

  document.addEventListener('keydown', event => {
    const openDialog = document.querySelector('dialog[open]');
    if (openDialog) return;
    const tag = event.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === 'o') {
      event.preventDefault();
      handleCommand('open');
    } else if (mod && event.key.toLowerCase() === 's') {
      event.preventDefault();
      handleCommand('write');
    } else if (mod && event.key.toLowerCase() === 'n') {
      event.preventDefault();
      handleCommand('new-file');
    } else if (mod && event.key.toLowerCase() === 'l') {
      event.preventDefault();
      if (state.source) showPathInput();
    } else if (event.key === 'F2' && state.source) {
      event.preventDefault();
      renameSelected();
    } else if (event.key === 'F5') {
      event.preventDefault();
      handleCommand('refresh');
    } else if (event.altKey && event.key === 'ArrowLeft') {
      event.preventDefault();
      goBack();
    } else if (event.altKey && event.key === 'ArrowRight') {
      event.preventDefault();
      goForward();
    } else if (event.key === 'Home' && state.source) {
      event.preventDefault();
      navigate('/');
    }
  });

  // drag and drop a zip anywhere on the explorer
  let dragDepth = 0;
  const explorer = el.browser.closest('.explorer');
  explorer.addEventListener('dragenter', event => {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
    dragDepth++;
    el.dropOverlay.hidden = false;
  });
  explorer.addEventListener('dragover', event => {
    if (event.dataTransfer?.types?.includes('Files')) event.preventDefault();
  });
  explorer.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) el.dropOverlay.hidden = true;
  });
  explorer.addEventListener('drop', async event => {
    event.preventDefault();
    dragDepth = 0;
    el.dropOverlay.hidden = true;
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    if (!/\.zip$/i.test(file.name)) {
      ui.toast('Only .zip files can be dropped here.', { kind: 'warn' });
      return;
    }
    if (state.source) {
      const confirmed = await ui.confirmDialog({
        title: 'Replace the working copy',
        message: `Open "${file.name}" and discard the current working copy?`,
        confirmLabel: 'Open zip',
        danger: true,
      });
      if (!confirmed) return;
    }
    openZipFile(file, { replace: Boolean(state.source) });
  });

  window.addEventListener('beforeunload', event => {
    if (state.dirty.size === 0) return;
    event.preventDefault();
    event.returnValue = '';
  });
}

function moveSelection(delta) {
  const rows = [...el.browser.querySelectorAll('.explorer-row[data-path]')];
  if (!rows.length) return;
  const index = rows.findIndex(row => row.dataset.path === state.selected);
  const next = Math.max(0, Math.min(rows.length - 1, index < 0 ? 0 : index + delta));
  select(rows[next].dataset.path);
  rows[next].scrollIntoView({ block: 'nearest' });
}

/* ------------------------------------------------------------------- boot */

async function boot() {
  if (!window.isSecureContext) {
    setStatus('Unsupported', 'error');
    ui.toast('Serve this page from https:// or http://localhost (a secure context is required).', { kind: 'err', timeout: 0 });
    el.emptyState.querySelector('p').textContent = 'This page must be served from https:// or http://localhost.';
    return;
  }
  if (!window.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') {
    setStatus('Unsupported', 'error');
    ui.toast('Cross-origin isolation is unavailable. Serve the page with server.mjs so COOP/COEP headers are sent.', { kind: 'err', timeout: 0 });
    return;
  }
  if (!('showDirectoryPicker' in window)) {
    setStatus('Unsupported', 'error');
    ui.toast('This browser does not support the File System Access API. Use a current Chrome or Edge.', { kind: 'err', timeout: 0 });
  }

  state.engine = new Engine();

  try {
    const scratchHost = new MemoryHost(state.scratch, { onProgress: () => {} });
    await state.engine.start();
    await state.engine.mountMemory('scratch', scratchHost);
    await applyCredentials();
    log('WebAssembly core ready (ps3xport + bundled keys.conf).', 'ok');
    setStatus('Ready');
  } catch (error) {
    setStatus('Error', 'error');
    log(`The WebAssembly core could not start: ${error?.message ?? error}`, 'err');
    ui.toast(String(error?.message ?? error), { kind: 'err', title: 'Core failed to start', timeout: 0 });
    return;
  }

  bindEvents();
  updateControls();
  render();
}

boot();
