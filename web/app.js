// ps3xport web panel.
//
// The page keeps a working copy of the backup contents in memory (a Vfs tree)
// and only streams bytes when a file is opened, zipped or written back. The
// WebAssembly core still does all archive work; this file drives it.

import { Engine } from './engine.js';
import { Vfs, MemoryHost, dirName } from './vfs.js';
import { buildZip, readZip } from './zip.js';
import {
  CHUNK_CAP, chunkName, chunkPattern, isTombstone, layoutArchive, planArchive,
  planTotals, projectAdditions,
} from './layout.js';
import {
  beginIndex, applyIndex, closeIndex, writePlanChunks, estimatePlan,
} from './writer.js';
import * as ui from './ui.js';

const MAX_ROWS = 1500;
const EDIT_LIMIT = 8 * 1024 * 1024;
const COPY_CHUNK = 4 * 1024 * 1024;
const SETTINGS_KEY = 'ps3xport.settings.v2';
const SCRATCH_ROOT = 'ps3xport-scratch';

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
  selection: new Set(),
  anchor: null,
  busy: false,
  shiftDown: false,
  settings: loadSettings(),
  dirty: new Set(),
  removed: new Map(), // path -> 'erase' | 'unlink'
  layouts: {},        // prefix -> layoutArchive() result
  chunkSizes: {},     // prefix -> [size per chunk]
  indexEntries: {},   // prefix -> index summary from listIndex
  stats: { files: 0, dirs: 0, bytes: 0 },
  details: null,
  scratchSeq: 0,
  editorPath: null,
  editorOriginal: '',
  installPrompt: null,
  progress: null,
  fileSpans: new Map(),
  filePrefixes: new Map(),
};

/* ------------------------------------------------------------------ utils */

function loadSettings() {
  const defaults = {
    advanced: false,
    deviceId: '',
    openPsid: '',
    deleteMode: 'erase',
    throughput: 0,
  };
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
    overallText: '',
    explicitProgress: false,
    expectedBytes: 0,
    setStep(text) {
      this.stepText = text ?? '';
      this.customDetail = null;
      dialog.setStep(text);
    },
    setDetail(text) {
      this.customDetail = text ?? null;
      dialog.setDetail(text);
    },
    setOverall(fraction, text) {
      this.overallText = text ?? '';
      this.explicitProgress = true;
      dialog.setOverall(fraction, text);
    },
    setFraction(value, text) {
      this.setOverall(value, text);
    },
    setChunk(info) {
      dialog.setChunk(info);
    },
    setWork(done, total, label) {
      if (!total) {
        this.setOverall(null, label ?? '');
        return;
      }
      this.setOverall(done / total, label ?? `${bytes(done)} of ${bytes(total)}`);
    },
    /**
     * Derives a fraction from the bytes the host moved, for flows where the
     * core does the work without reporting steps (file extraction, a rebuild
     * from a content folder, ...).
     */
    expectBytes(total) {
      this.expectedBytes = total;
    },
    get cancelled() {
      return dialog.cancelled;
    },
    close() {
      clearInterval(timer);
      dialog.close();
      if (state.progress === controller) state.progress = null;
    },
  };
  state.progress = controller;

  let lastBytes = 0;
  let lastTime = performance.now();
  const timer = setInterval(() => {
    const moved = state.engine.bytesMoved;
    const now = performance.now();
    const rate = (moved - lastBytes) / Math.max((now - lastTime) / 1000, 0.001);
    lastBytes = moved;
    lastTime = now;
    if (!controller.explicitProgress && controller.expectedBytes > 0) {
      dialog.setOverall(Math.min(0.999, moved / controller.expectedBytes), `${bytes(moved)} of ${bytes(controller.expectedBytes)}`);
    }
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
  setOverall() {},
  setChunk() {},
  setWork() {},
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
    progress.setOverall(1);
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
  clearSelection();
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
    note.innerHTML = `<span class="name"><span class="label muted">Showing the first ${shown.length.toLocaleString()} of ${entries.length.toLocaleString()} entries - open a subfolder or use the path bar.</span></span>`;
    el.browser.append(note);
  }

  const folders = entries.filter(entry => entry.type === 'dir').length;
  el.browserStatus.textContent = entries.length === 0
    ? 'This folder is empty'
    : `${folders} folder${folders === 1 ? '' : 's'} · ${entries.length - folders} file${entries.length - folders === 1 ? '' : 's'}`;
  const chosen = selectionBytes();
  const parts = [];
  if (chosen.count) {
    parts.push(`${chosen.count.toLocaleString()} selected${chosen.files ? ` · ${bytes(chosen.bytes)}` : ''}`);
  }
  const changes = state.dirty.size + state.removed.size;
  if (changes) parts.push(`${changes} unsaved change${changes === 1 ? '' : 's'}`);
  if (!parts.length) parts.push(`${state.stats.files.toLocaleString()} files · ${bytes(state.stats.bytes)}`);
  el.browserUsage.textContent = parts.join(' · ');
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
  row.addEventListener('click', () => select(null));
  return row;
}

function buildRow(entry) {
  const row = document.createElement('div');
  row.className = `explorer-row ${entry.type === 'dir' ? 'folder' : 'file'}`;
  row.dataset.path = entry.path;
  row.dataset.type = entry.type;
  if (state.selection.has(entry.path)) row.classList.add('selected');

  const locked = entry.type === 'file'
    && (entry.node.originPrefix === 'archive2' || (entry.node.content?.kind === 'archive' && entry.node.content.prefix !== 'archive'));
  const badges = [];
  if (state.dirty.has(entry.path)) badges.push('<span class="badge dirty">edited</span>');
  if (locked) badges.push('<span class="badge locked">protected</span>');
  const spanCount = entry.type === 'file' ? fileSpan(entry.path) : 0;
  if (spanCount > 1) {
    badges.push(`<span class="badge spans" title="This file is stored across ${spanCount} archive chunks">spans ${spanCount} chunks</span>`);
  }

  const name = document.createElement('span');
  name.className = 'name';
  name.innerHTML = `<svg><use href="#${entry.type === 'dir' ? 'i-folder' : 'i-file'}"/></svg><span class="label"></span>${badges.join('')}`;
  name.querySelector('.label').textContent = entry.name;

  const size = document.createElement('span');
  size.className = 'size';
  size.textContent = entry.type === 'file' ? bytes(entry.size) : '-';

  const mode = document.createElement('span');
  mode.className = 'mode';
  mode.textContent = `0${(entry.mode & 0o7777).toString(8)}`;

  const date = document.createElement('span');
  date.className = 'date';
  date.textContent = entry.mtime ? ui.formatDate(entry.mtime) : '-';

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
    ['Backup ID', state.details?.id ?? '-', true],
    ['Layout', state.details?.layout ?? '-'],
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
  rename: () => Boolean(state.source && state.selection.size === 1),
  delete: () => Boolean(state.source && state.selection.size > 0),
  'delete-unlink': () => Boolean(state.source && state.selection.size > 0),
  'delete-erase': () => Boolean(state.source && state.selection.size > 0),
  properties: () => Boolean(state.source && state.selection.size > 0),
  compact: () => Boolean(state.source && Object.values(state.layouts).some(layout => layout.entries.some(entry => isTombstone(entry.path)))),
  refresh: () => Boolean(state.source?.handle),
  'show-details': () => Boolean(state.source),
  install: () => Boolean(state.installPrompt),
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
  const pendingChanges = state.dirty.size + state.removed.size;
  el.write.title = pendingChanges
    ? `Write ${pendingChanges} pending change(s) back to the device (Ctrl+S)`
    : 'Write the working copy back to the device (Ctrl+S)';

  for (const button of document.querySelectorAll('.menu-panel [data-cmd]')) {
    const rule = MENU_RULES[button.dataset.cmd];
    button.disabled = busy || (rule ? !rule() : false);
  }
}

function clearSelection() {
  state.selection.clear();
  state.selected = null;
  state.anchor = null;
  paintSelection();
  updateControls();
}

function paintSelection() {
  for (const row of el.browser.querySelectorAll('.explorer-row[data-path]')) {
    row.classList.toggle('selected', state.selection.has(row.dataset.path));
  }
}

function rowPaths() {
  return [...el.browser.querySelectorAll('.explorer-row[data-path]')].map(row => row.dataset.path);
}

function select(path, { toggle = false, range = false } = {}) {
  if (!path) {
    clearSelection();
    return;
  }
  if (range && state.anchor) {
    const rows = rowPaths();
    const from = rows.indexOf(state.anchor);
    const to = rows.indexOf(path);
    if (from >= 0 && to >= 0) {
      state.selection.clear();
      for (let i = Math.min(from, to); i <= Math.max(from, to); i++) state.selection.add(rows[i]);
      state.selected = path;
      paintSelection();
      updateControls();
      return;
    }
  }
  if (toggle) {
    if (state.selection.has(path)) state.selection.delete(path);
    else {
      state.selection.add(path);
      state.anchor = path;
    }
    state.selected = state.selection.has(path) ? path : [...state.selection].pop() ?? null;
  } else {
    state.selection.clear();
    state.selection.add(path);
    state.anchor = path;
    state.selected = path;
  }
  paintSelection();
  updateControls();
}

/** Selected nodes, in row order. */
function selectedEntries() {
  const rows = rowPaths();
  const ordered = rows.filter(path => state.selection.has(path));
  for (const path of state.selection) if (!ordered.includes(path)) ordered.push(path);
  return ordered
    .map(path => ({ path, node: state.tree.get(path) }))
    .filter(entry => entry.node);
}

function selectionBytes() {
  let total = 0;
  let files = 0;
  for (const { node } of selectedEntries()) {
    if (node.type === 'file') {
      files++;
      total += node.size;
    }
  }
  return { files, bytes: total, count: state.selection.size };
}

function fileSpan(path) {
  const node = state.tree.get(path);
  if (!node || node.type !== 'file') return 0;
  const prefix = node.originPrefix ?? node.content?.prefix;
  if (!prefix) return 0;
  const source = node.archivePath ?? node.content?.srcPath ?? path;
  return state.fileSpans?.get(`${prefix}\u0000${source}`) ?? 0;
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
  await run(`Reading ${path}`, async progress => {
    progress.expectBytes(node.size);
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
  return await run(`Opening ${path}`, async progress => {
    progress.expectBytes(node.size);
    return await readText(path);
  });
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
    : 'Unsaved changes - Ctrl+S to apply';
}

function saveEditor() {
  const path = state.editorPath;
  if (!path) return;
  const value = el.editorText.value;
  if (value !== state.editorOriginal) {
    const node = state.tree.get(path);
    const next = state.tree.putBlob(path, new Blob([value], { type: 'text/plain' }), {
      mtime: new Date(),
      mode: node?.mode,
    });
    next.originPrefix = node?.originPrefix ?? node?.content?.prefix ?? 'archive';
    next.archivePath = node?.archivePath;
    state.removed.delete(path);
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
      if (!dir.path) continue;
      const node = vfs.ensureDir(dir.path);
      if (dir.mode) node.mode = dir.mode;
      if (dir.mtime) node.mtime = new Date(dir.mtime * 1000);
    }
    for (const file of index.files) {
      // Unlinked entries stay in the archive (their bytes keep the following
      // files addressable) but are not part of the browsable tree.
      if (isTombstone(file.path)) continue;
      const stamp = file.mtime ? new Date(file.mtime * 1000) : new Date();
      const node = vfs.put(file.path, {
        size: file.size,
        mtime: stamp,
        mode: file.mode || 0o644,
        content: { kind: 'archive', prefix: index.prefix, srcPath: file.path },
      });
      node.originPrefix = index.prefix;
      node.archivePath = file.path;
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
  root, label, kind, handle = null, protectedPresent = false, zipSizes = null, progress = noProgress,
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
      log('archive2.dat needs a Device ID. Add one in Settings -> Advanced mode to include it.', 'warn');
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
    kind, label, root, handle, indexes, protectedPresent, protectedLoaded, zipSizes,
  };
  state.details = {
    id: main.id,
    layout: protectedPresent ? (protectedLoaded ? 'Normal + copy-protected' : 'Normal + copy-protected (ignored)') : 'Normal',
    archives: indexes.map(index => ({
      prefix: index.prefix, id: index.id, files: index.files.length, dirs: index.dirs.length, size: index.totalFileSizes,
    })),
  };
  state.dirty.clear();
  state.removed.clear();
  clearSelection();
  state.cwd = '/';
  resetHistory();
  recount();
  progress.setStep('Mapping the archive chunks');
  await loadLayouts({ progress });
  log(`Loaded ${label}: ${main.files.length.toLocaleString()} files, ${main.dirs.length.toLocaleString()} folders, ${bytes(main.totalFileSizes)}.`, 'ok');
  render();
}

/** Reads the actual size of every data chunk of an archive. */
async function listChunkSizes({ prefix }) {
  const sizes = [];
  if (state.source?.kind === 'zip') {
    const pattern = chunkPattern(prefix);
    const found = new Map();
    for (const [name, size] of state.source.zipSizes ?? []) {
      const match = pattern.exec(name);
      if (match) found.set(Number(match[1]), size);
    }
    for (let index = 0; found.has(index); index++) sizes.push(found.get(index));
    return sizes;
  }
  const handle = state.source?.handle;
  if (!handle) return sizes;
  for (let index = 0; index < 10000; index++) {
    try {
      const fileHandle = await handle.getFileHandle(chunkName(prefix, index));
      sizes.push((await fileHandle.getFile()).size);
    } catch {
      break;
    }
  }
  return sizes;
}

async function loadLayouts({ progress = noProgress } = {}) {
  state.layouts = {};
  state.chunkSizes = {};
  state.fileSpans = new Map();
  state.filePrefixes = new Map();
  state.indexEntries = {};
  if (!state.source?.indexes?.length) return;
  let done = 0;
  for (const index of state.source.indexes) {
    progress.setStep(`Mapping ${index.prefix}.dat`);
    state.indexEntries[index.prefix] = index;
    for (const file of index.files) state.filePrefixes.set(file.path, index.prefix);
    const sizes = await listChunkSizes({ prefix: index.prefix });
    state.chunkSizes[index.prefix] = sizes;
    try {
      const layout = layoutArchive(
        index.files.map(file => ({
          path: file.path, size: file.size, mode: file.mode, mtime: file.mtime, flags: file.flags,
        })),
        sizes,
      );
      state.layouts[index.prefix] = layout;
      for (const entry of layout.entries) {
        state.fileSpans.set(`${index.prefix}\u0000${entry.path}`, entry.spanCount);
      }
      log(`${index.prefix}.dat: ${sizes.length} chunk${sizes.length === 1 ? '' : 's'} (${bytes(sizes.reduce((a, b) => a + b, 0))}), ${layout.entries.length.toLocaleString()} entries mapped.`, 'dim');
    } catch (error) {
      state.layouts[index.prefix] = null;
      log(`${index.prefix}.dat could not be mapped: ${error.message}`, 'warn');
    }
    done++;
    progress.setFraction(done / state.source.indexes.length);
  }
}

async function loadBackupFolder(handle, { progress = noProgress, replace = false } = {}) {
  progress.setStep('Scanning the folder');
  const entries = await listFolderNames(handle);
  const hasArchive = entries.some(entry => entry.name === 'archive.dat' && entry.kind === 'file');

  const journal = entries.find(entry => entry.name.startsWith('.ps3xport-journal-'));
  if (journal) {
    log(`A previous write into "${handle.name}" was interrupted (${journal.name}). The archive may be incomplete; writing again will repair the chunks and index it touches.`, 'warn');
    ui.toast('A previous write was interrupted. Check the archive before using it on a console.', {
      kind: 'warn', title: 'Interrupted write', timeout: 12000,
    });
  }

  if (!hasArchive) {
    // A common mistake is picking PS3/EXPORT instead of PS3/EXPORT/<timestamp>.
    const candidates = [];
    for (const entry of entries) {
      if (entry.kind !== 'directory' || entry.name.startsWith('.ps3xport')) continue;
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
  state.layouts = {};
  state.chunkSizes = {};
  state.fileSpans = new Map();
  state.filePrefixes = new Map();
  state.indexEntries = {};
  state.dirty.clear();
  state.removed.clear();
  clearSelection();
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
  if (!state.source || (state.dirty.size === 0 && state.removed.size === 0)) return true;
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
    handle = await window.showDirectoryPicker({ id: 'ps3xport-backup', mode: 'readwrite' });
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
    const zipSizes = new Map();
    let hasArchive = false;
    for (const entry of entries) {
      if (entry.isDir) {
        zipVfs.ensureDir(entry.path);
        continue;
      }
      zipSizes.set(entry.path, entry.size);
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
        root: 'zip', label: file.name, kind: 'zip', protectedPresent, zipSizes, progress,
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

function stamps() {
  const now = new Date();
  const pad = value => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function isDeviceRoot(path) {
  return path === '/' || /^\/dev_[^/]+$/.test(path);
}

function ownerPrefix(node) {
  return node.originPrefix ?? node.content?.prefix ?? 'archive';
}

function allTreeFiles() {
  const files = [];
  for (const { path, node } of state.tree.files()) files.push({ path, node, size: node.size });
  return files;
}

function filesForPrefix(prefix) {
  return allTreeFiles().filter(file => ownerPrefix(file.node) === prefix);
}

function unlinkSetFor(prefix) {
  const set = new Set();
  for (const [path, mode] of state.removed) {
    if (mode === 'unlink' && state.filePrefixes?.get(path) === prefix) set.add(path);
  }
  return set;
}

/** Rebuilds the directory table of one index from the working copy. */
function dirsForPrefix(prefix) {
  const nodes = new Map();
  if (prefix === 'archive') {
    for (const { path, node } of state.tree.dirs()) {
      if (!isDeviceRoot(path)) nodes.set(path, node);
    }
  } else {
    for (const dir of state.indexEntries[prefix]?.dirs ?? []) {
      const node = state.tree.get(dir.path);
      if (node?.type === 'dir') nodes.set(dir.path, node);
    }
    for (const file of filesForPrefix(prefix)) {
      let parent = dirName(file.path);
      while (parent !== '/' && !nodes.has(parent)) {
        const node = state.tree.get(parent);
        if (node?.type === 'dir') nodes.set(parent, node);
        parent = dirName(parent);
      }
    }
  }
  return [...nodes.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, node]) => ({
      path,
      mode: node.mode ?? 0x41FF,
      mtime: Math.floor((node.mtime instanceof Date ? node.mtime.getTime() : Date.now()) / 1000),
      flags: path.startsWith('/dev_flash2') ? 3 : 1,
    }));
}

function buildWritePlans({ forceFull = false, compact = false } = {}) {
  const byOwner = new Map();
  for (const file of allTreeFiles()) {
    const owner = ownerPrefix(file.node);
    if (!byOwner.has(owner)) byOwner.set(owner, []);
    byOwner.get(owner).push(file);
  }
  const prefixes = new Set(state.source.indexes.map(index => index.prefix));
  for (const owner of byOwner.keys()) prefixes.add(owner);

  const plans = [];
  for (const prefix of [...prefixes].sort()) {
    const index = state.source.indexes.find(item => item.prefix === prefix) ?? null;
    if (index && !state.layouts[prefix]) {
      throw new Error(`The layout of ${prefix}.dat could not be computed, so it cannot be updated safely.`);
    }
    const layout = index ? state.layouts[prefix] : layoutArchive([], []);
    const plan = planArchive({
      prefix,
      index: index?.files ?? [],
      layout,
      treeFiles: byOwner.get(prefix) ?? [],
      unlink: unlinkSetFor(prefix),
      forceFull: forceFull && Boolean(index),
      compact,
    });
    plan.id = index?.id ?? null;
    plan.archiveType = index?.archiveType ?? (prefix === 'archive2' ? 4 : 5);
    plan.hasIndex = Boolean(index);
    plan.hasWork = !index || plan.mode !== 'none' || forceFull || compact
      || plan.indexOps.removals.length || plan.indexOps.renames.length
      || plan.indexOps.updates.length || plan.indexOps.additions.length;
    plans.push(plan);
  }
  return plans.filter(plan => plan.hasWork);
}

function keepChunkIndices(plan) {
  const keep = new Set(plan.rewrites.map(chunk => chunk.index));
  if (!plan.clearTarget) {
    const upto = plan.startSegment ?? plan.layout.chunkCount;
    for (let index = 0; index < Math.min(upto, plan.layout.chunkCount); index++) keep.add(index);
  }
  return keep;
}

function estimateIndexBytes(plan, dirs) {
  const entries = (plan.layout.entries.length + plan.indexOps.additions.length) * 0x540;
  return 0x100 + entries + (dirs?.length ?? 0) * 0x450;
}

async function sameEntry(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  try {
    return await a.isSameEntry(b);
  } catch {
    return false;
  }
}

async function writeTextFile(dir, name, text) {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();
}

async function copyFileBetween(sourceDir, sourceName, targetDir, targetName, onBytes) {
  const source = await (await sourceDir.getFileHandle(sourceName)).getFile();
  const writable = await (await targetDir.getFileHandle(targetName, { create: true })).createWritable();
  try {
    for (let offset = 0; offset < source.size; offset += COPY_CHUNK) {
      const end = Math.min(offset + COPY_CHUNK, source.size);
      const buffer = await source.slice(offset, end).arrayBuffer();
      await writable.write(buffer);
      onBytes?.(buffer.byteLength);
    }
  } finally {
    await writable.close();
  }
  return source.size;
}

async function fileSizeIn(dir, name) {
  try {
    return (await (await dir.getFileHandle(name)).getFile()).size;
  } catch {
    return 0;
  }
}

/* ------------------------------------------------------------ plan dialog */

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function listSection(title, entries, { note, detail } = {}) {
  const section = element('section');
  section.append(element('h3', '', `${title} (${entries.length.toLocaleString()})`));
  if (note) section.append(element('p', 'note', note));
  if (!entries.length) {
    section.append(element('p', 'note', 'None'));
    return section;
  }
  const scroll = element('div', 'scroll');
  const list = element('div', 'file-list');
  const limit = 250;
  for (const entry of entries.slice(0, limit)) {
    const line = element('div', 'file-line');
    line.append(element('span', 'name', entry.path));
    line.append(element('span', 'num', detail ? detail(entry) : bytes(entry.size ?? 0)));
    list.append(line);
  }
  if (entries.length > limit) {
    list.append(element('div', 'file-line', `... and ${(entries.length - limit).toLocaleString()} more`));
  }
  scroll.append(list);
  section.append(scroll);
  return section;
}

function chunkSection(plans) {
  const section = element('section');
  section.append(element('h3', '', 'Archive chunks'));
  const scroll = element('div', 'scroll');
  const list = element('div', 'file-list');
  let any = false;
  for (const plan of plans) {
    for (const chunk of plan.rewrites) {
      any = true;
      const name = chunkName(plan.prefix, chunk.index);
      const newBytes = chunk.items.reduce((sum, item) => sum + (item.kind === 'copy' ? 0 : item.length), 0);
      const head = element('div', 'file-line');
      head.append(element('span', 'name', name));
      head.append(element('span', 'num', `${bytes(chunk.end)} · ${bytes(newBytes)} new`));
      list.append(head);
      const files = [...new Set(chunk.items.map(item => item.path).filter(path => path !== '(padding)'))];
      const line = element('div', 'file-line');
      line.style.paddingLeft = '1.4rem';
      line.append(element(
        'span',
        'name muted',
        `${files.length.toLocaleString()} file${files.length === 1 ? '' : 's'}: ${files.slice(0, 6).join(', ')}${files.length > 6 ? ', ...' : ''}`,
      ));
      list.append(line);
      if (files.length) {
        const details = document.createElement('details');
        details.style.padding = '0 0 .3rem 1.4rem';
        const summary = document.createElement('summary');
        summary.className = 'note';
        summary.textContent = `Show the ${files.length.toLocaleString()} file${files.length === 1 ? '' : 's'} in ${name}`;
        details.append(summary);
        const inner = element('div', 'file-list');
        for (const file of files.slice(0, 500)) inner.append(element('div', 'file-line', file));
        if (files.length > 500) inner.append(element('div', 'file-line', `... and ${(files.length - 500).toLocaleString()} more`));
        details.append(inner);
        list.append(details);
      }
    }
    for (const index of plan.deleteChunks) {
      any = true;
      const line = element('div', 'file-line');
      line.append(element('span', 'name', chunkName(plan.prefix, index)));
      line.append(element('span', 'num', 'will be removed'));
      list.append(line);
    }
  }
  if (!any) list.append(element('div', 'file-line', 'No data chunks need to be written.'));
  scroll.append(list);
  section.append(scroll);
  return section;
}

function spanningChanges(plans) {
  const spanning = [];
  for (const plan of plans) {
    for (const change of plan.changes.added) {
      if (change.size > CHUNK_CAP - 0x50) {
        const risky = change.size > (CHUNK_CAP - 0x50) * 2;
        spanning.push({ path: change.path, detail: `new · ${bytes(change.size)}${risky ? ' · spans more than 2 chunks' : ''}` });
      }
    }
    for (const change of plan.changes.modified) {
      const entry = plan.layout.entries.find(item => item.path === change.path);
      if (entry && entry.spanCount > 1) {
        spanning.push({ path: change.path, detail: `${entry.spanCount} chunks · ${bytes(change.size)}` });
      }
    }
  }
  return spanning;
}

function estimateWrite(plans, dirsByPrefix, directByPrefix) {
  const rate = state.settings.throughput > 0 ? state.settings.throughput : 30 * 1024 * 1024;
  let milliseconds = 0;
  let work = 0;
  for (const plan of plans) {
    const totals = planTotals(plan);
    const indexBytes = estimateIndexBytes(plan, dirsByPrefix.get(plan.prefix));
    const direct = directByPrefix?.get(plan.prefix) ?? new Set();
    const staged = plan.rewrites.reduce((sum, chunk) => sum + (direct.has(chunk.index) ? 0 : chunk.end), 0);
    work += totals.readBytes * 2 + totals.writeBytes + staged * 2 + indexBytes * 2;
    milliseconds += estimatePlan(plan, rate) - ((plan.totals.chunkBytes - staged) / rate) * 1000;
  }
  return { milliseconds: Math.max(500, milliseconds), work, rate };
}

function describePlan(plan) {
  if (!plan.hasIndex) return `Create (${plan.changes.added.length.toLocaleString()} files)`;
  switch (plan.mode) {
    case 'none': return 'Index only';
    case 'append': return plan.startSegment >= plan.layout.chunkCount
      ? 'Append to a new chunk'
      : `Append to chunk ${String(plan.startSegment).padStart(2, '0')}`;
    case 'inplace': return 'Rewrite the affected chunks';
    case 'tail': return `Rewrite chunks ${String(plan.startSegment).padStart(2, '0')}-${String(Math.max(plan.startSegment, plan.layout.chunkCount - 1)).padStart(2, '0')}`;
    case 'full': return 'Full rebuild';
    default: return plan.mode;
  }
}

async function showWritePlanDialog({ plans, target, sameFolder, estimate, directByPrefix }) {
  const body = element('div', 'properties');
  const overview = element('dl', 'info-list');
  const addRow = (term, value, mono = false) => {
    overview.append(element('dt', '', term));
    const dd = element('dd', mono ? 'mono' : '', value);
    overview.append(dd);
  };
  addRow('Destination', `${target.name}${sameFolder ? ' (same folder)' : ' (different folder)'}`);
  for (const plan of plans) {
    addRow(`${plan.prefix}.dat`, describePlan(plan));
  }
  const readBytes = plans.reduce((sum, plan) => sum + planTotals(plan).readBytes, 0);
  const writeBytes = plans.reduce((sum, plan) => sum + planTotals(plan).writeBytes, 0);
  const chunkBytes = plans.reduce((sum, plan) => sum + plan.totals.chunkBytes, 0);
  addRow('Data to copy', bytes(readBytes));
  addRow('New data', bytes(writeBytes));
  addRow('Chunks written', `${plans.reduce((sum, plan) => sum + plan.rewrites.length, 0)} (${bytes(chunkBytes)})`);
  const directCount = plans.reduce((sum, plan) => sum + plan.rewrites.filter(chunk => directByPrefix?.get(plan.prefix)?.has(chunk.index)).length, 0);
  const stagedCount = plans.reduce((sum, plan) => sum + plan.rewrites.length, 0) - directCount;
  addRow('Written straight to the device', `${directCount} new chunk${directCount === 1 ? '' : 's'}`);
  addRow('Staged before replacing', `${stagedCount} existing chunk${stagedCount === 1 ? '' : 's'}`);
  addRow('Chunks removed', String(plans.reduce((sum, plan) => sum + plan.deleteChunks.length, 0)));
  const overviewSection = element('section');
  overviewSection.append(element('h3', '', 'Write plan'), overview);
  overviewSection.append(element(
    'p',
    'note',
    'Nothing is extracted: unchanged files are copied straight from the existing chunks, and only the chunks listed below are produced again. New chunks go straight to their final name; replaced chunks are staged in a hidden folder until the index is ready.',
  ));
  body.append(overviewSection);

  const added = plans.flatMap(plan => plan.changes.added);
  const modified = plans.flatMap(plan => plan.changes.modified);
  const erased = plans.flatMap(plan => plan.changes.erased);
  const unlinked = plans.flatMap(plan => plan.changes.unlinked);
  const renamed = plans.flatMap(plan => plan.changes.renamed.map(change => ({ path: `${change.from} -> ${change.to}`, size: change.size })));

  body.append(listSection('Added files', added));
  body.append(listSection('Modified files', modified, {
    detail: entry => (`${bytes(entry.size)}${entry.oldSize !== entry.size ? ` (was ${bytes(entry.oldSize)})` : ''}`),
  }));
  body.append(listSection('Deleted files (erased)', erased, {
    note: 'Their bytes are removed and the following data is moved up.',
    detail: entry => bytes(entry.size),
  }));
  body.append(listSection('Deleted files (unlinked)', unlinked, {
    note: 'Their index entries are dropped but the bytes stay in place, which keeps the update fast. Use "Compact unlinked data" later to reclaim the space.',
    detail: entry => bytes(entry.size),
  }));
  body.append(listSection('Renamed files', renamed));

  const spanning = spanningChanges(plans);
  if (spanning.length) {
    body.append(listSection('Files spanning chunks', spanning, {
      note: 'These files are larger than the free space of a single chunk, so they are stored across a chunk boundary.',
    }));
  }

  body.append(chunkSection(plans));

  const time = element('section');
  time.append(element('h3', '', 'Estimated time'));
  time.append(element(
    'p',
    'note',
    `About ${ui.formatDuration(estimate.milliseconds)} at ${bytes(estimate.rate)}/s. The dialog shows the real speed and a live estimate while it runs.`,
  ));
  body.append(time);

  const actions = [
    { label: 'Cancel', value: false, kind: 'secondary' },
    { label: 'Write backup', value: true, kind: 'danger' },
  ];
  return await ui.openDialog({
    title: 'Write to device',
    subtitle: 'Hold Shift when starting the write to skip this dialog next time.',
    body,
    width: 'min(48rem, calc(100vw - 2rem))',
    actions,
  }) === true;
}

/* ---------------------------------------------------------- write to device */

async function writeToDevice({ compact = false } = {}) {
  if (!state.source) return;
  // Snapshot the modifier now: the permission prompts and plan calculation
  // below are asynchronous and the key may be released by then.
  const skipConfirm = state.shiftDown;

  let target = state.writeTarget;
  if (!target) {
    try {
      const handle = await window.showDirectoryPicker({ id: 'ps3xport-write', mode: 'readwrite' });
      target = { handle, name: handle.name };
      state.writeTarget = target;
    } catch (error) {
      if (error?.name !== 'AbortError') ui.toast(error.message ?? String(error), { kind: 'err', title: 'No target folder' });
      return;
    }
  }

  const same = await sameEntry(state.source.handle, target.handle);
  let plans;
  try {
    plans = buildWritePlans({ forceFull: !same, compact });
  } catch (error) {
    ui.toast(error.message ?? String(error), { kind: 'err', title: 'Cannot update this backup' });
    return;
  }
  if (!plans.length) {
    ui.toast('There is nothing to write: the working copy already matches the archive.', { kind: 'info' });
    return;
  }

  const dirsByPrefix = new Map(plans.map(plan => [plan.prefix, dirsForPrefix(plan.prefix)]));

  // A chunk whose file does not exist in the destination can be written under
  // its final name right away; only replaced chunks have to be staged.
  const present = new Set();
  for await (const [name, entry] of target.handle.entries()) {
    if (entry.kind === 'file' && /^archive2?_\d+\.dat$/i.test(name)) present.add(name);
  }
  const directByPrefix = new Map();
  for (const plan of plans) {
    const direct = new Set();
    for (const chunk of plan.rewrites) {
      if (!present.has(chunkName(plan.prefix, chunk.index))) direct.add(chunk.index);
    }
    directByPrefix.set(plan.prefix, direct);
  }

  const estimate = estimateWrite(plans, dirsByPrefix, directByPrefix);

  if (!skipConfirm) {
    const confirmed = await showWritePlanDialog({ plans, target, sameFolder: same, estimate, directByPrefix });
    if (!confirmed) return;
  } else {
    log('Write confirmation skipped with Shift.', 'warn');
  }

  const archive2Loaded = state.source.indexes.some(index => index.prefix === 'archive2');
  const archive2Size = archive2Loaded
    ? filesForPrefix('archive2').reduce((sum, file) => sum + file.size, 0)
    : null;
  const sourceBase = `/px/${state.source.root}`;
  const stamp = stamps();
  const outDirName = `.ps3xport-out-${stamp}`;
  const journalName = `.ps3xport-journal-${stamp}.json`;
  const startedAt = performance.now();
  let committing = false;

  const result = await run('Writing backup', async progress => {
    progress.setStep('Preparing the incremental update');
    const outHandle = await target.handle.getDirectoryHandle(outDirName, { create: true });

    const units = plans.map(plan => {
      const totals = planTotals(plan);
      const indexBytes = estimateIndexBytes(plan, dirsByPrefix.get(plan.prefix));
      const direct = directByPrefix.get(plan.prefix) ?? new Set();
      const stagedBytes = plan.rewrites.reduce((sum, chunk) => sum + (direct.has(chunk.index) ? 0 : chunk.end), 0);
      return {
        plan,
        direct,
        generation: totals.readBytes * 2 + totals.writeBytes + 0x50 * plan.rewrites.length,
        indexBytes,
        commit: stagedBytes * 2 + indexBytes * 2,
      };
    });
    const totalWork = units.reduce((sum, unit) => sum + unit.generation + unit.indexBytes + unit.commit, 0) || 1;
    const activityTotal = () => state.engine.activity.reads + state.engine.activity.writes;
    let done = 0;
    let base = activityTotal();
    let current = null;
    const report = (label) => {
      progress.setWork(Math.min(totalWork, done), totalWork, label ? `${bytes(done)} of ${bytes(totalWork)} · ${label}` : '');
    };
    const settle = () => {
      done = Math.min(totalWork, done + (activityTotal() - base));
      base = activityTotal();
    };
    const timer = setInterval(() => {
      const inChunk = current ? activityTotal() - current.base : 0;
      progress.setWork(Math.min(totalWork, done + (activityTotal() - base)), totalWork, current?.name ?? '');
      if (current && current.total) {
        progress.setChunk({
          label: current.name,
          fraction: Math.min(1, inChunk / current.total),
          text: `${bytes(Math.min(inChunk, current.total))} / ${bytes(current.total)}`,
        });
      }
    }, 300);
    report();

    const directNames = [];
    for (const unit of units) {
      for (const chunk of unit.plan.rewrites) {
        if (unit.direct.has(chunk.index)) directNames.push(chunkName(unit.plan.prefix, chunk.index));
      }
    }
    const directBase = same ? sourceBase : '/px/device';

    try {
      if (directNames.length && !same) await state.engine.setRoot('device', target.handle);
      await writeTextFile(target.handle, journalName, JSON.stringify({
        stamp,
        startedAt: new Date().toISOString(),
        archives: plans.map(plan => ({
          prefix: plan.prefix,
          chunks: plan.rewrites.map(chunk => chunkName(plan.prefix, chunk.index)),
          removed: plan.deleteChunks.map(index => chunkName(plan.prefix, index)),
        })),
      }, null, 2));

      await state.engine.setRoot('out', outHandle);

      for (const unit of units) {
        const { plan } = unit;
        if (progress.cancelled) throw new DOMException('Cancelled', 'AbortError');
        progress.setStep(`${plan.hasIndex ? 'Updating' : 'Creating'} ${plan.prefix}.dat`);
        progress.setChunk(null);
        const opened = await beginIndex({
          engine: state.engine,
          open: plan.hasIndex ? `${sourceBase}/${plan.prefix}.dat` : null,
          create: plan.hasIndex ? null : plan.archiveType,
        });
        try {
          await writePlanChunks({
            plan,
            idHex: opened.id,
            archiveType: plan.archiveType,
            engine: state.engine,
            base: chunk => (unit.direct.has(chunk.index) ? directBase : '/px/out'),
            sourceBase,
            materialize,
            shouldCancel: () => progress.cancelled,
            onChunkStart: info => {
              settle();
              current = { name: info.name, total: info.total, base: activityTotal() };
              progress.setChunk({ label: info.name, fraction: 0, text: `0 B / ${bytes(info.total)}` });
            },
          });
          settle();
          current = null;
          progress.setChunk(null);
          progress.setStep(`Writing ${plan.prefix}.dat`);
          await applyIndex({
            plan,
            engine: state.engine,
            saveTo: `/px/out/${plan.prefix}.dat`,
            dirs: dirsByPrefix.get(plan.prefix),
            archive2Size: plan.prefix === 'archive' ? archive2Size : null,
          });
          settle();
          base = activityTotal();
          report(`${plan.prefix}.dat`);
        } finally {
          await closeIndex(state.engine);
        }
      }

      if (progress.cancelled) throw new DOMException('Cancelled', 'AbortError');

      clearInterval(timer);
      settle();
      committing = true;
      progress.disableCancel?.();
      progress.setStep('Replacing the archive on the device');
      progress.setChunk(null);

      for (const unit of units) {
        const { plan, direct } = unit;
        for (const chunk of plan.rewrites) {
          if (direct.has(chunk.index)) continue;
          const name = chunkName(plan.prefix, chunk.index);
          let copied = 0;
          await copyFileBetween(outHandle, name, target.handle, name, delta => {
            copied += delta;
            done = Math.min(totalWork, done + delta * 2);
            progress.setChunk({
              label: name,
              fraction: chunk.end ? Math.min(1, copied / chunk.end) : null,
              text: `${bytes(copied)} / ${bytes(chunk.end)}`,
            });
            report(name);
          });
        }
      }

      progress.setStep('Removing chunks that are no longer needed');
      for (const unit of units) {
        const { plan } = unit;
        const keep = keepChunkIndices(plan);
        const pattern = chunkPattern(plan.prefix);
        const remove = [];
        for await (const [name, entry] of target.handle.entries()) {
          if (entry.kind !== 'file') continue;
          const match = pattern.exec(name);
          if (match) {
            if (!keep.has(Number(match[1]))) remove.push(name);
          } else if (name === `${plan.prefix}.bak`) {
            remove.push(name);
          }
        }
        for (const name of remove) await target.handle.removeEntry(name).catch(() => {});
      }

      progress.setStep('Writing the archive index');
      for (const unit of units) {
        const { plan } = unit;
        const name = `${plan.prefix}.dat`;
        await copyFileBetween(outHandle, name, target.handle, name, delta => {
          done = Math.min(totalWork, done + delta * 2);
          report(name);
        });
        report(name);
      }

      progress.setStep('Cleaning up');
      await target.handle.removeEntry(journalName).catch(() => {});
      await target.handle.removeEntry(outDirName, { recursive: true }).catch(() => {});
      clearInterval(timer);
      state.engine.host.invalidate('usb');

      state.dirty.clear();
      state.removed.clear();
      const elapsed = Math.max(1, performance.now() - startedAt);
      const measured = done / (elapsed / 1000);
      state.settings.throughput = state.settings.throughput
        ? Math.round(state.settings.throughput * 0.6 + measured * 0.4)
        : Math.round(measured);
      saveSettings();

      const chunkCount = plans.reduce((sum, plan) => sum + plan.rewrites.length, 0);
      log(`Wrote ${chunkCount} chunk${chunkCount === 1 ? '' : 's'} and ${plans.length} index file${plans.length === 1 ? '' : 's'} to ${target.name} in ${ui.formatDuration(elapsed)}.`, 'ok');
      return { plans, elapsed };
    } catch (error) {
      if (!committing) {
        for (const name of directNames) await target.handle.removeEntry(name).catch(() => {});
        await target.handle.removeEntry(outDirName, { recursive: true }).catch(() => {});
        await target.handle.removeEntry(journalName).catch(() => {});
      } else {
        log(`The write stopped while replacing the archive. The new chunks were left in "${outDirName}" and "${journalName}" marks the interrupted write.`, 'err');
        await writeTextFile(target.handle, journalName, JSON.stringify({
          stamp,
          interrupted: true,
          failedAt: new Date().toISOString(),
          archives: plans.map(plan => ({
            prefix: plan.prefix,
            chunks: plan.rewrites.map(chunk => chunkName(plan.prefix, chunk.index)),
            removed: plan.deleteChunks.map(index => chunkName(plan.prefix, index)),
          })),
        }, null, 2)).catch(() => {});
      }
      throw error;
    } finally {
      clearInterval(timer);
    }
  }, { cancellable: true });

  if (result) {
    ui.toast(
      `Wrote ${result.plans.map(plan => `${plan.prefix}.dat`).join(' and ')} to ${target.name}.`,
      { kind: 'ok', title: 'Saved to device' },
    );
    await run('Reloading the new backup', progress => loadBackupFolder(target.handle, { progress, replace: true }));
  }
}

/* ------------------------------------------------------------- downloads */

async function downloadZip() {
  if (!state.source) return;
  const total = state.stats.bytes || 1;
  const stem = sanitizeName((state.source.label || 'ps3xport').replace(/\.zip$/i, '')) || 'ps3xport';
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
  const node = state.tree.putBlob(path, new Blob([]), { mtime: new Date() });
  node.originPrefix = 'archive';
  state.removed.delete(path);
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
  const target = `${parent}/${name}`.replace(/\/+/g, '/');
  state.dirty.add(path);
  state.dirty.add(target);
  state.selection = new Set([target]);
  state.selected = target;
  state.anchor = target;
  state.removed.delete(target);
  recount();
  render();
  log(`Renamed ${path} to ${target}.`, 'ok');
}

async function deleteSelected(modeOverride) {
  const entries = selectedEntries();
  if (!entries.length) return;

  const files = new Map();
  for (const { path, node } of entries) {
    if (node.type === 'file') {
      files.set(path, node);
      continue;
    }
    for (const child of state.tree.files(path)) files.set(child.path, child.node);
  }

  const archiveKey = (path, node) => node.archivePath ?? path;
  const archived = [...files.entries()]
    .filter(([path, node]) => state.filePrefixes.has(archiveKey(path, node)))
    .map(([path]) => path);
  let mode = modeOverride;
  if (!mode) {
    if (state.shiftDown) {
      mode = state.settings.deleteMode;
      log(`Delete confirmation skipped with Shift; using "${mode}".`, 'warn');
    } else if (!archived.length) {
      const confirmed = await ui.confirmDialog({
        title: entries.length === 1 ? 'Delete' : 'Delete items',
        message: entries.length === 1
          ? `Remove "${entries[0].path}" from the working copy?`
          : `Remove ${entries.length.toLocaleString()} items from the working copy?`,
        detail: 'Nothing in this selection is part of an archive, so only the working copy changes.',
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!confirmed) return;
      mode = 'erase';
    } else {
      mode = await askDeleteMode(entries, files, archived);
      if (!mode) return;
    }
  }

  state.settings.deleteMode = mode;
  saveSettings();

  for (const { path } of entries) state.tree.remove(path);
  for (const [path, node] of files) {
    const key = archiveKey(path, node);
    if (state.filePrefixes.has(key)) {
      state.removed.set(key, mode);
    } else {
      state.removed.delete(key);
      state.dirty.delete(path);
    }
  }
  for (const { path } of entries) state.dirty.add(path);
  clearSelection();
  recount();
  render();
  const what = entries.length === 1 ? entries[0].path : `${entries.length.toLocaleString()} items`;
  log(mode === 'unlink'
    ? `Unlinked ${what} (${files.size.toLocaleString()} files stay in the archive until you compact).`
    : `Erased ${what} from the working copy (${files.size.toLocaleString()} files).`, 'ok');
  ui.toast(
    mode === 'unlink' ? 'Unlinked from the index. Use Compact to reclaim the space.' : 'Deleted from the working copy.',
    { kind: 'ok', title: 'Deleted' },
  );
}

function eraseImpact(files) {
  const affected = new Map();
  for (const [path, node] of files) {
    const key = node.archivePath ?? path;
    const prefix = state.filePrefixes.get(key);
    if (!prefix) continue;
    const layout = state.layouts[prefix];
    const entry = layout?.entries.find(item => item.path === key);
    if (!entry || !entry.spans.length) continue;
    const first = entry.spans[0].segment;
    affected.set(prefix, Math.min(affected.get(prefix) ?? Number.POSITIVE_INFINITY, first));
  }
  let bytes = 0;
  for (const [prefix, first] of affected) {
    const sizes = state.chunkSizes[prefix] ?? [];
    for (let index = first; index < sizes.length; index++) bytes += sizes[index];
  }
  return { affected, bytes };
}

async function askDeleteMode(entries, files, archived) {
  const impact = eraseImpact(files);
  const rate = state.settings.throughput > 0 ? state.settings.throughput : 30 * 1024 * 1024;
  const chunks = [...impact.affected.entries()]
    .map(([prefix, first]) => {
      const count = (state.chunkSizes[prefix]?.length ?? 0) - first;
      return `${prefix}_${String(first).padStart(2, '0')}.dat${count > 1 ? ` ... ${prefix}_${String(first + count - 1).padStart(2, '0')}.dat` : ''}`;
    })
    .join(', ');
  const title = entries.length === 1 && entries[0].node.type === 'dir' ? 'Delete folder' : 'Delete';
  const body = element('div', 'properties');
  const info = element('dl', 'info-list');
  const add = (term, value, mono = false) => {
    info.append(element('dt', '', term));
    info.append(element('dd', mono ? 'mono' : '', value));
  };
  add('Selection', entries.length === 1 ? entries[0].path : `${entries.length.toLocaleString()} items`);
  add('Files affected', files.size.toLocaleString());
  add('Archive entries', archived.length.toLocaleString());
  add('Bytes erased', bytes(impact.bytes));
  const section = element('section');
  section.append(element('h3', '', 'What happens on Write'), info);
  const unlink = element('div', 'switch');
  unlink.innerHTML = '<div><strong>Unlink</strong><span>Drops the index entries only. The bytes stay in their chunks, so the update is instant and the following files keep their positions. Reclaim the space later with <em>Compact unlinked data</em>.</span></div>';
  const erase = element('div', 'switch');
  erase.innerHTML = `<div><strong>Erase</strong><span>Removes the data and moves every following file up. ${
    chunks ? `This rewrites ${chunks}` : 'No archived files are selected.'
  } (${bytes(impact.bytes)}, about ${ui.formatDuration((impact.bytes * 2 / rate) * 1000)}).</span></div>`;
  section.append(unlink, erase);
  section.append(element('p', 'kbd-hint', 'Hold Shift while starting the delete to repeat the last choice without this dialog.'));
  body.append(section);
  return await ui.openDialog({
    title,
    body,
    width: 'min(40rem, calc(100vw - 2rem))',
    actions: [
      { label: 'Cancel', value: null, kind: 'secondary' },
      { label: 'Unlink', value: 'unlink', kind: 'secondary' },
      { label: 'Erase', value: 'erase', kind: 'danger' },
    ],
  });
}

/* ------------------------------------------------------------- properties */

function pendingPlacements() {
  const byPrefix = new Map();
  for (const file of allTreeFiles()) {
    if (state.filePrefixes.has(file.path)) continue;
    const prefix = ownerPrefix(file.node);
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
    byPrefix.get(prefix).push(file);
  }
  const placements = new Map();
  for (const [prefix, files] of byPrefix) {
    const layout = state.layouts[prefix];
    if (!layout) continue;
    const ordered = files.slice().sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
    for (const [path, placement] of projectAdditions(layout, ordered)) {
      placements.set(path, { prefix, ...placement });
    }
  }
  return placements;
}

function segmentsFor(path, placements) {
  const node = state.tree.get(path);
  if (!node || node.type !== 'file') return null;
  const prefix = state.filePrefixes.get(path) ?? ownerPrefix(node);
  const layout = state.layouts[prefix];
  if (!layout) return null;
  const sourcePath = node.archivePath ?? (node.content?.kind === 'archive' ? node.content.srcPath : path);
  const entry = layout.entries.find(item => item.path === sourcePath);
  if (entry) return { prefix, spans: entry.spans, approximate: false };
  const placement = placements?.get(path);
  if (placement) return { prefix, spans: placement.spans, approximate: true };
  return null;
}

async function collectStats(paths, { onProgress, token } = {}) {
  const placements = pendingPlacements();
  const stats = {
    files: 0,
    dirs: 0,
    bytes: 0,
    chunks: new Map(),
    spanning: [],
    largest: [],
  };
  let processed = 0;

  const addFile = (path, node) => {
    stats.files++;
    stats.bytes += node.size;
    const found = segmentsFor(path, placements);
    const prefix = found?.prefix ?? ownerPrefix(node);
    if (found && found.spans.length > 1) {
      stats.spanning.push({ path, chunks: found.spans.length, size: node.size });
    }
    for (const span of found?.spans ?? []) {
      const key = `${prefix}\u0000${span.segment}`;
      const bucket = stats.chunks.get(key) ?? { prefix, index: span.segment, bytes: 0, files: new Set() };
      bucket.bytes += span.length;
      bucket.files.add(path);
      stats.chunks.set(key, bucket);
    }
    stats.largest.push({ path, size: node.size });
    if (stats.largest.length > 400) {
      stats.largest.sort((a, b) => b.size - a.size);
      stats.largest.length = 40;
    }
  };

  for (const root of paths) {
    const node = state.tree.get(root);
    if (!node) continue;
    if (node.type === 'file') {
      addFile(root, node);
      continue;
    }
    for (const _ of state.tree.dirs(root)) stats.dirs++;
    for (const entry of state.tree.files(root)) {
      if (token?.cancelled) return stats;
      addFile(entry.path, entry.node);
      processed++;
      if (processed % 1500 === 0) {
        onProgress?.({ files: stats.files, bytes: stats.bytes });
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
  }
  stats.largest.sort((a, b) => b.size - a.size);
  stats.largest.length = Math.min(10, stats.largest.length);
  return stats;
}

function chunkListSection(stats) {
  const section = element('section');
  section.append(element('h3', '', `Stored in ${stats.chunks.size.toLocaleString()} chunk${stats.chunks.size === 1 ? '' : 's'}`));
  if (!stats.chunks.size) {
    section.append(element('p', 'note', 'Nothing in this selection is stored in an archive chunk yet.'));
    return section;
  }
  const list = element('div', 'chunk-list');
  const buckets = [...stats.chunks.values()].sort((a, b) => (a.prefix === b.prefix ? a.index - b.index : a.prefix.localeCompare(b.prefix)));
  for (const bucket of buckets.slice(0, 120)) {
    const size = state.chunkSizes[bucket.prefix]?.[bucket.index] ?? CHUNK_CAP;
    const line = element('div', 'chunk-line');
    line.append(element('span', 'chunk-name', chunkName(bucket.prefix, bucket.index)));
    const bar = element('div', 'chunk-bar');
    const fill = element('span');
    fill.style.width = `${Math.min(100, (bucket.bytes / Math.max(1, size)) * 100)}%`;
    bar.append(fill);
    line.append(bar);
    line.append(element('span', 'chunk-bytes', `${bytes(bucket.bytes)} · ${bucket.files.size.toLocaleString()} file${bucket.files.size === 1 ? '' : 's'}`));
    list.append(line);
  }
  if (buckets.length > 120) list.append(element('p', 'note', `... and ${(buckets.length - 120).toLocaleString()} more chunks`));
  section.append(list);
  return section;
}

function largestSection(stats) {
  const section = element('section');
  section.append(element('h3', '', 'Largest files'));
  if (!stats.largest.length) {
    section.append(element('p', 'note', 'None'));
    return section;
  }
  const list = element('div', 'file-list');
  for (const entry of stats.largest) {
    const line = element('div', 'file-line');
    line.append(element('span', 'name', entry.path));
    line.append(element('span', 'num', bytes(entry.size)));
    list.append(line);
  }
  section.append(list);
  return section;
}

async function showFileProperties(path) {
  const node = state.tree.get(path);
  if (!node) return;
  const placements = pendingPlacements();
  const found = segmentsFor(path, placements);
  const body = element('div', 'properties');
  const general = element('section');
  general.append(element('h3', '', 'General'));
  const info = element('dl', 'info-list');
  const add = (term, value, mono = false) => {
    info.append(element('dt', '', term));
    info.append(element('dd', mono ? 'mono' : '', value));
  };
  add('Name', path.split('/').pop());
  add('Path', path, true);
  add('Type', node.type === 'dir' ? 'Folder' : 'File');
  add('Size', node.type === 'file' ? `${node.size.toLocaleString()} bytes (${bytes(node.size)})` : '-');
  add('Mode', `0${(node.mode ?? 0).toString(8)}`);
  add('Modified', ui.formatDate(node.mtime));
  add('Status', state.removed.has(path)
    ? `Deleted (${state.removed.get(path) === 'unlink' ? 'unlinked' : 'erased'}, pending write)`
    : state.dirty.has(path) ? 'Edited (pending write)' : 'Unchanged');
  general.append(info);
  body.append(general);

  const storage = element('section');
  storage.append(element('h3', '', 'Archive storage'));
  if (found) {
    const chunkInfo = element('dl', 'info-list');
    const push = (term, value) => {
      chunkInfo.append(element('dt', '', term));
      chunkInfo.append(element('dd', '', value));
    };
    push('Archive', `${found.prefix}.dat`);
    push('Chunks', String(found.spans.length));
    for (let i = 0; i < found.spans.length; i++) {
      const span = found.spans[i];
      push(found.spans.length > 1 ? `Part ${i + 1}` : 'Chunk',
        `${chunkName(found.prefix, span.segment)} at ${bytes(span.offset)} (${bytes(span.length)})`);
    }
    if (found.approximate) {
      push('Note', 'New file: the chunk is an estimate, based on appending it after the current contents.');
    }
    if (found.spans.length > 2) {
      storage.append(element('p', 'note warn', 'This file spans more than two chunks. The archive format only records the position of the following files correctly when a file crosses one chunk boundary, so data after it may be unreadable on a console.'));
    }
    storage.append(chunkInfo);
  } else {
    storage.append(element('p', 'note', 'This file is not stored in a data chunk yet.'));
  }
  if (node.content?.kind === 'archive' && state.dirty.has(path)) {
    storage.append(element('p', 'note', 'The edited content replaces the stored bytes when you press Write. Same-size edits stay in place; other edits move the following data.'));
  }
  body.append(storage);

  if (node.type === 'dir') {
    const token = { cancelled: false };
    const scan = element('section');
    scan.append(element('h3', '', 'Contents'));
    const scanInfo = element('p', 'note', 'Scanning the folder...');
    scan.append(scanInfo);
    body.append(scan);
    const dialogPromise = ui.openDialog({
      title: 'Properties',
      subtitle: path,
      body,
      width: 'min(40rem, calc(100vw - 2rem))',
      actions: [{ label: 'Close', value: null, kind: 'primary' }],
      onOpen: async () => {
        const stats = await collectStats([path], {
          token,
          onProgress: progress => {
            scanInfo.textContent = `Scanning... ${progress.files.toLocaleString()} files, ${bytes(progress.bytes)}`;
          },
        });
        if (token.cancelled) return;
        scanInfo.textContent = `${stats.files.toLocaleString()} files · ${stats.dirs.toLocaleString()} folders · ${bytes(stats.bytes)}`;
        body.append(chunkListSection(stats), largestSection(stats));
        if (stats.spanning.length) {
          const span = element('section');
          span.append(element('h3', '', 'Files spanning chunks'));
          const list = element('div', 'file-list');
          for (const item of stats.spanning.slice(0, 100)) {
            const line = element('div', 'file-line');
            line.append(element('span', 'name', item.path));
            line.append(element('span', 'num', `${item.chunks} chunks · ${bytes(item.size)}`));
            list.append(line);
          }
          if (stats.spanning.length > 100) list.append(element('p', 'note', `... and ${(stats.spanning.length - 100).toLocaleString()} more`));
          span.append(list);
          body.append(span);
        }
      },
    });
    const result = await dialogPromise;
    token.cancelled = true;
    return result;
  }

  return await ui.openDialog({
    title: 'Properties',
    subtitle: path,
    body,
    width: 'min(40rem, calc(100vw - 2rem))',
    actions: [{ label: 'Close', value: null, kind: 'primary' }],
  });
}

async function showProperties() {
  const entries = selectedEntries();
  if (!entries.length) return;
  if (entries.length === 1 && entries[0].node.type === 'file') {
    await showFileProperties(entries[0].path);
    return;
  }

  const paths = entries.map(entry => entry.path);
  const token = { cancelled: false };
  const body = element('div', 'properties');
  const summary = element('section');
  summary.append(element('h3', '', entries.length === 1 ? 'Folder' : 'Selection'));
  const info = element('dl', 'info-list');
  const add = (term, value, mono = false) => {
    info.append(element('dt', '', term));
    info.append(element('dd', mono ? 'mono' : '', value));
  };
  add(entries.length === 1 ? 'Folder' : 'Items', entries.length === 1 ? paths[0] : `${entries.length.toLocaleString()} items`, entries.length === 1);
  const progressLine = element('p', 'note', 'Scanning...');
  summary.append(info, progressLine);
  body.append(summary);

  const chunksHost = element('div');
  chunksHost.style.display = 'grid';
  chunksHost.style.gap = '1rem';
  body.append(chunksHost);

  const dialogPromise = ui.openDialog({
    title: 'Properties',
    subtitle: entries.length === 1 ? paths[0] : `${entries.length.toLocaleString()} items`,
    body,
    width: 'min(42rem, calc(100vw - 2rem))',
    actions: [{ label: 'Close', value: null, kind: 'primary' }],
    onOpen: async () => {
      const stats = await collectStats(paths, {
        token,
        onProgress: progress => {
          progressLine.textContent = `Scanning... ${progress.files.toLocaleString()} files, ${bytes(progress.bytes)}`;
        },
      });
      if (token.cancelled) return;
      add('Files', stats.files.toLocaleString());
      add('Folders', stats.dirs.toLocaleString());
      add('Total size', `${stats.bytes.toLocaleString()} bytes (${bytes(stats.bytes)})`);
      if (stats.spanning.length) add('Spanning chunks', `${stats.spanning.length.toLocaleString()} files`);
      progressLine.textContent = `Scanned ${stats.files.toLocaleString()} files.`;
      chunksHost.append(chunkListSection(stats), largestSection(stats));
    },
  });
  const result = await dialogPromise;
  token.cancelled = true;
  return result;
}

async function compactUnlinked() {
  if (!state.source) return;
  const tombstones = Object.values(state.layouts)
    .flatMap(layout => layout?.entries.filter(entry => isTombstone(entry.path)) ?? []);
  if (!tombstones.length) {
    ui.toast('There is no unlinked data to compact.', { kind: 'info' });
    return;
  }
  const confirmed = state.shiftDown || await ui.confirmDialog({
    title: 'Compact unlinked data',
    message: `Remove ${tombstones.length.toLocaleString()} unlinked entr${tombstones.length === 1 ? 'y' : 'ies'} and reclaim their space?`,
    detail: 'Every chunk after the first unlinked file is rewritten, which can take a while for a large archive.',
    confirmLabel: 'Compact',
    danger: true,
  });
  if (!confirmed) return;
  await writeToDevice({ compact: true });
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
    const previous = state.tree.get(path);
    if (previous?.type === 'dir') continue;
    const node = state.tree.putBlob(path, file, { mtime: new Date(file.lastModified || Date.now()) });
    node.originPrefix = previous?.originPrefix ?? previous?.content?.prefix ?? 'archive';
    node.archivePath = previous?.archivePath;
    state.removed.delete(path);
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
  state.removed.clear();
  state.layouts = {};
  state.chunkSizes = {};
  state.fileSpans = new Map();
  state.filePrefixes = new Map();
  state.indexEntries = {};
  clearSelection();
  state.cwd = '/';
  resetHistory();
  state.stats = { files: 0, dirs: 0, bytes: 0 };
  el.log.replaceChildren();
  log('Closed the working copy.', 'dim');
  render();
}

async function showDetails() {
  if (!state.source) return;
  const body = element('div', 'properties');
  const rows = [
    ['Source', `${state.source.kind === 'zip' ? 'Zip file' : 'Folder'} - ${state.source.label}`],
    ['Backup ID', state.details?.id ?? '-', true],
    ['Layout', state.details?.layout ?? '-'],
    ['Archives', state.details?.archives.map(a => `${a.prefix}.dat`).join(', ') || 'none'],
    ['Files', state.stats.files.toLocaleString()],
    ['Folders', state.stats.dirs.toLocaleString()],
    ['Content size', bytes(state.stats.bytes)],
    ['Edited', String(state.dirty.size)],
    ['Pending deletes', String(state.removed.size)],
    ['Target', state.writeTarget?.name ?? 'not set (Write asks for a folder)'],
    ['Throughput', state.settings.throughput ? `${bytes(state.settings.throughput)}/s` : 'not measured yet'],
  ];
  const list = element('dl', 'info-list');
  for (const [term, value, mono] of rows) {
    list.append(element('dt', '', term));
    list.append(element('dd', mono ? 'mono' : '', value));
  }
  const overview = element('section');
  overview.append(element('h3', '', 'Backup'), list);
  body.append(overview);

  for (const index of state.source.indexes) {
    const layout = state.layouts[index.prefix];
    const section = element('section');
    section.append(element('h3', '', `${index.prefix}.dat`));
    const chunkSizes = state.chunkSizes[index.prefix] ?? [];
    const used = layout ? layout.usage.reduce((a, b) => a + b, 0) : 0;
    const total = chunkSizes.reduce((a, b) => a + b, 0);
    const info = element('dl', 'info-list');
    const add = (term, value, mono = false) => {
      info.append(element('dt', '', term));
      info.append(element('dd', mono ? 'mono' : '', value));
    };
    add('Files', index.files.filter(file => !isTombstone(file.path)).length.toLocaleString());
    add('Dirs', index.dirs.length.toLocaleString());
    add('Chunks', `${chunkSizes.length} (${bytes(total)})`);
    add('Data', `${bytes(used)} in chunks`);
    add('Spans', layout ? `${layout.entries.filter(entry => entry.spanCount > 1).length} files across chunks` : 'not mapped');
    const tombstones = layout?.entries.filter(entry => isTombstone(entry.path)).length ?? 0;
    if (tombstones) add('Unlinked', `${tombstones} entries (${bytes(layout.entries.filter(entry => isTombstone(entry.path)).reduce((sum, entry) => sum + entry.size, 0))})`);
    section.append(info);
    if (chunkSizes.length && chunkSizes.length <= 40) {
      const chunkList = element('div', 'chunk-list');
      chunkSizes.forEach((size, chunkIndex) => {
        const line = element('div', 'chunk-line');
        line.append(element('span', 'chunk-name', chunkName(index.prefix, chunkIndex)));
        const bar = element('div', 'chunk-bar');
        const fill = element('span');
        fill.style.width = `${Math.min(100, (size / CHUNK_CAP) * 100)}%`;
        bar.append(fill);
        line.append(bar);
        line.append(element('span', 'chunk-bytes', bytes(size)));
        chunkList.append(line);
      });
      section.append(chunkList);
    }
    body.append(section);
  }

  const actions = [{ label: 'Close', value: null, kind: 'primary' }];
  if (Object.values(state.layouts).some(layout => layout?.entries.some(entry => isTombstone(entry.path)))) {
    actions.unshift({
      label: 'Compact unlinked data...',
      kind: 'secondary',
      onClick: ({ close }) => {
        close(null);
        compactUnlinked();
        return false;
      },
    });
  }
  await ui.openDialog({
    title: 'Backup details',
    body,
    width: 'min(42rem, calc(100vw - 2rem))',
    actions,
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
    </div>
    <div class="field">
      <label for="set-delete">Delete without a dialog (Shift + Delete)</label>
      <select id="set-delete">
        <option value="erase">Erase - reclaim the space, rewrite affected chunks</option>
        <option value="unlink">Unlink - instant, keep the bytes in the archive</option>
      </select>
      <span class="hint">Holding Shift while deleting (or writing) skips the confirmation and uses this choice.</span>
    </div>
    <div class="field">
      <label>Measured write speed</label>
      <span class="hint" id="set-throughput">${state.settings.throughput ? `${bytes(state.settings.throughput)}/s` : 'not measured yet'}</span>
    </div>`;
  const advanced = body.querySelector('#set-advanced');
  const device = body.querySelector('#set-device');
  const psid = body.querySelector('#set-psid');
  const deleteMode = body.querySelector('#set-delete');
  advanced.checked = state.settings.advanced;
  device.value = state.settings.deviceId;
  psid.value = state.settings.openPsid;
  deleteMode.value = state.settings.deleteMode ?? 'erase';

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
        close({ advanced: advanced.checked, deviceId, openPsid, deleteMode: deleteMode.value });
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
    ['Ctrl+A', 'Select every item in the folder'],
    ['Ctrl+Click / Shift+Click', 'Add to the selection / select a range'],
    ['Click / double-click', 'Select / open an item'],
    ['F2', 'Rename the selection'],
    ['F4', 'Properties (size, chunks, storage)'],
    ['Delete', 'Delete the selection (choose Unlink or Erase)'],
    ['Shift+Delete', 'Delete without a dialog, using the saved mode'],
    ['F5', 'Reload from the folder'],
    ['Alt+<- / Alt+->', 'Go back / forward'],
    ['Backspace / Home', 'Up one level / backup root'],
    ['Enter', 'Open the selection'],
    ['Shift + any action', 'Skip its confirmation dialog (Write, delete, compact, ...)'],
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
    title: 'About ps3xport',
    body: `<p class="muted">A local PS3 backup editor. The <a href="https://github.com/kakaroto/ps3xport" target="_blank" rel="noreferrer">ps3xport</a> C core (GPLv3) runs as WebAssembly inside this page, so backups are read and written without uploading anything.</p>
      <p class="muted">Writes are incremental: renaming only rewrites the index, adding files only appends to the last chunk (or starts a new one), and only a delete or a size change rewrites the chunks after the affected file.</p>
      <p class="muted">The page works offline once loaded and can be installed as an app.</p>
      <p class="muted">Web panel by <a href="https://github.com/KiwifruitDev" target="_blank" rel="noreferrer">KiwifruitDev</a> (c) 2026, MIT licensed.</p>`,
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
    <p class="muted">Build a new backup from a folder that mirrors the PS3 filesystem (<code>dev_hdd0</code>, <code>dev_flash2</code>, ...). The archive is written into a timestamped subfolder of the output folder.</p>
    <div class="field">
      <label>Content folder</label>
      <button type="button" class="secondary" id="cb-content">Choose content folder...</button>
      <span class="hint" id="cb-content-name">Not selected</span>
    </div>
    <div class="field">
      <label>Output folder</label>
      <button type="button" class="secondary" id="cb-output">Choose output folder...</button>
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
          picked.content = await window.showDirectoryPicker({ id: 'ps3xport-content', mode: 'read' });
          body.querySelector('#cb-content-name').textContent = picked.content.name;
        } catch (error) {
          if (error?.name !== 'AbortError') ui.toast(error.message ?? String(error), { kind: 'err' });
        }
      });
      body.querySelector('#cb-output').addEventListener('click', async () => {
        try {
          picked.output = await window.showDirectoryPicker({ id: 'ps3xport-output', mode: 'readwrite' });
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
    let total = 0;
    for await (const entry of walkDirectory(picked.content)) {
      if (entry.kind === 'file') total += entry.size;
    }
    progress.expectBytes(total * 2);
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
    handle = await window.showDirectoryPicker({ id: 'ps3xport-content', mode: 'readwrite' });
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
  delete: () => deleteSelected(),
  'delete-unlink': () => deleteSelected('unlink'),
  'delete-erase': () => deleteSelected('erase'),
  properties: showProperties,
  compact: compactUnlinked,
  'import-files': () => {
    el.fileInput.value = '';
    el.fileInput.click();
  },
  'import-folder': () => {
    el.folderInput.value = '';
    el.folderInput.click();
  },
  install: async () => {
    if (!state.installPrompt) {
      ui.toast('Use the browser menu to install this page as an app.', { kind: 'info' });
      return;
    }
    state.installPrompt.prompt();
    const choice = await state.installPrompt.userChoice.catch(() => null);
    if (choice?.outcome === 'accepted') ui.toast('ps3xport will now open like an app.', { kind: 'ok', title: 'Installed' });
    state.installPrompt = null;
    updateControls();
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
    if (!row) {
      select(null);
      el.browser.focus({ preventScroll: true });
      return;
    }
    select(row.dataset.path, {
      toggle: event.ctrlKey || event.metaKey,
      range: event.shiftKey,
    });
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
    if (!state.selection.has(row.dataset.path)) select(row.dataset.path);
    const paths = [...state.selection];
    const single = paths.length === 1 ? row.dataset.path : null;
    const isDir = single ? state.tree.get(single)?.type === 'dir' : false;
    const items = [];
    if (single) {
      items.push({
        label: isDir ? 'Open' : 'Edit',
        icon: isDir ? 'i-folder' : 'i-pencil',
        action: () => (isDir ? navigate(single) : openEditor(single)),
      });
      if (!isDir) items.push({ label: 'Download', icon: 'i-download', action: () => downloadNode(single) });
      items.push({ rule: true });
    }
    items.push({ label: paths.length > 1 ? `Properties (${paths.length})...` : 'Properties...', icon: 'i-info', action: showProperties });
    if (single) items.push({ label: 'Rename...', icon: 'i-pencil', action: renameSelected });
    items.push({ rule: true });
    items.push({ label: 'Delete...', icon: 'i-trash', danger: true, action: () => deleteSelected() });
    items.push({ label: 'Unlink (keep bytes)', icon: 'i-trash', action: () => deleteSelected('unlink') });
    items.push({ label: 'Erase (rewrite chunks)', icon: 'i-trash', danger: true, action: () => deleteSelected('erase') });
    ui.showContextMenu(items, event.clientX, event.clientY);
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
      event.preventDefault();
      deleteSelected(event.shiftKey ? state.settings.deleteMode : undefined);
    } else if (event.key === 'F2') {
      renameSelected();
    } else if (event.key === 'F4') {
      event.preventDefault();
      showProperties();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      const rows = rowPaths();
      state.selection = new Set(rows);
      state.selected = rows[rows.length - 1] ?? null;
      state.anchor = rows[0] ?? null;
      paintSelection();
      updateControls();
    } else if (event.key === 'Escape') {
      clearSelection();
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

  document.addEventListener('keyup', event => {
    state.shiftDown = event.shiftKey;
  });
  window.addEventListener('blur', () => {
    state.shiftDown = false;
  });

  document.addEventListener('keydown', event => {
    state.shiftDown = event.shiftKey;
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
      state.shiftDown = event.shiftKey;
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
    if (state.dirty.size === 0 && state.removed.size === 0) return;
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

  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register(new URL('./sw.js', import.meta.url), { scope: './' })
      .then(() => log('Offline cache ready - the app can be installed and used without a network.', 'dim'))
      .catch(error => log(`Offline cache unavailable: ${error.message}`, 'warn'));
  }
}

window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  state.installPrompt = event;
  updateControls();
  log('This page can be installed as an app (View -> Install app).', 'dim');
});

window.addEventListener('appinstalled', () => {
  state.installPrompt = null;
  updateControls();
  log('Installed as an app.', 'ok');
});

boot();
