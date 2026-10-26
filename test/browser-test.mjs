// Browser end-to-end test: drives the real file-browser UI in Chrome through
// the File System Access API (backed by OPFS so it can run unattended).
//
//   node test/browser-test.mjs
//
// Requires Google Chrome or Microsoft Edge to be installed (channel "chrome",
// falling back to "msedge").

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { readZip } from '../web/zip.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(here, '..');

let port = 8123;
let baseUrl = '';

async function findFreePort() {
  return await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const assigned = probe.address().port;
      probe.close(() => resolve(assigned));
    });
  });
}

let passes = 0;
let failures = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEquals(actual, expected, message) {
  if (String(actual) !== String(expected)) throw new Error(`${message}: expected ${expected}, got ${actual}`);
}

let currentPage = null;

async function test(name, fn) {
  try {
    await fn();
    passes++;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures++;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error.message}`);
    if (currentPage && process.env.PX_VERBOSE) {
      console.log(`       log: ${await currentPage.textContent('#log').catch(() => '?')}`);
      console.log(`       toasts: ${JSON.stringify(await currentPage.$$eval('.toast', nodes => nodes.map(node => node.textContent)).catch(() => []))}`);
      console.log(`       dialogs: ${JSON.stringify(await currentPage.$$eval('dialog', nodes => nodes.map(node => `${node.id}:${node.open}`)).catch(() => []))}`);
    }
  }
}

const pattern = (length, modulus) => {
  const buffer = Buffer.alloc(length);
  for (let i = 0; i < length; i++) buffer[i] = (i * 7 + i % 13) % modulus;
  return buffer;
};

const fixtures = {
  'dev_hdd0/home/00000001/savedata/GAME1/SAVE.DAT': pattern(700 * 1024, 251),
  'dev_hdd0/game/TEST/USRDIR/EBOOT.BIN': pattern(2500 * 1024, 253),
  'dev_flash2/etc/note.txt': Buffer.from('ps3xport wasm browser test\n'),
};

const expectedHashes = Object.fromEntries(Object.entries(fixtures).map(([name, data]) => [
  `/${name}`,
  crypto.createHash('sha256').update(data).digest('hex'),
]));

const editedNote = 'edited in the browser\nsecond line ✓\n';

function startServer() {
  const child = spawn(process.execPath, [path.join(projectRoot, 'server.mjs'), `--port=${port}`], {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start in time')), 15000);
    child.stdout.on('data', chunk => {
      if (String(chunk).includes('running at')) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.stderr.on('data', chunk => process.stderr.write(`[server] ${chunk}`));
    child.on('exit', code => {
      clearTimeout(timer);
      reject(new Error(`server exited with code ${code}`));
    });
  });
}

async function launch() {
  for (const channel of ['chrome', 'msedge']) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch {
      // try the next channel
    }
  }
  throw new Error('Neither Chrome nor Edge could be launched by Playwright.');
}

async function menuCommand(page, menu, command) {
  await page.click(`.menu-button[data-menu="${menu}"]`);
  await page.click(`.menu-panel[data-panel="${menu}"] [data-cmd="${command}"]`);
}

async function logHas(page, text, timeout = 60000) {
  await page.waitForFunction(
    wanted => [...document.querySelectorAll('#log span')].some(node => node.textContent.includes(wanted)),
    text,
    { timeout },
  );
}

/** Waits until the log contains at least `times` lines with `text`. */
async function logHasTimes(page, text, times, timeout = 120000) {
  await page.waitForFunction(
    ({ wanted, count }) => [...document.querySelectorAll('#log span')]
      .filter(node => node.textContent.includes(wanted)).length >= count,
    { wanted: text, count: times },
    { timeout },
  );
}

async function rows(page) {
  return await page.$$eval('.explorer-row[data-path]', nodes => nodes.map(node => node.dataset.path));
}

async function navigateTo(page, target) {
  await page.click('#path-edit');
  await page.fill('#path-input', target);
  await page.press('#path-input', 'Enter');
  await page.waitForFunction(
    wanted => [...document.querySelectorAll('.crumb')].some(node => node.textContent.trim() === wanted),
    target.split('/').filter(Boolean).pop() ?? 'ps3xport',
  );
}

async function openEditorFor(page, target) {
  await page.dblclick(`.explorer-row[data-path="${target}"]`);
  await page.waitForSelector('#editor-dialog[open]');
}

async function waitForDownload(page) {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 120000 }),
    page.click('#download-button'),
  ]);
  const target = path.join(os.tmpdir(), `ps3xport-test-${Date.now()}.zip`);
  await download.saveAs(target);
  return target;
}

async function zipContents(file) {
  const buffer = await fs.promises.readFile(file);
  const archive = await readZip(new Blob([buffer]));
  const entries = new Map();
  for (const entry of archive.entries) {
    if (entry.isDir) continue;
    entries.set(entry.path, new Uint8Array(await (await entry.getBlob()).arrayBuffer()));
  }
  return entries;
}

async function main() {
  port = await findFreePort();
  baseUrl = `http://localhost:${port}/`;
  const server = await startServer();
  const browser = await launch();
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  currentPage = page;
  const consoleErrors = [];
  page.on('console', message => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
      console.log(`[console] ${message.text()}`);
    } else if (process.env.PXFS_DEBUG) {
      console.log(`[console] ${message.text()}`);
    }
  });
  page.on('pageerror', error => {
    consoleErrors.push(String(error));
    console.log(`[pageerror] ${error}`);
  });

  try {
    const debugFs = Boolean(process.env.PXFS_DEBUG);
    await page.addInitScript(debug => {
      window.__PXFS_DEBUG = debug;
      window.__pxPickers = [];
      window.showDirectoryPicker = async () => {
        if (window.__pxPickers.length === 0) throw new Error('no directory picker was queued');
        return window.__pxPickers.shift();
      };
    }, debugFs);

    await page.goto(baseUrl);
    await page.waitForFunction(() => document.querySelector('#app-status')?.textContent === 'Ready', null, { timeout: 30000 });

    await test('page is cross-origin isolated and the wasm core boots', async () => {
      assertEquals(await page.evaluate(() => window.crossOriginIsolated), 'true', 'crossOriginIsolated');
      assertEquals(await page.textContent('#app-status'), 'Ready', 'status');
      assert(await page.isVisible('#empty-state'), 'empty state is visible');
      assert(await page.isDisabled('#write-button'), 'write is disabled without a backup');
    });

    await test('seeds an OPFS content tree', async () => {
      await page.evaluate(async ({ files }) => {
        const root = await navigator.storage.getDirectory();
        for (const [name, values] of Object.entries(files)) {
          const segments = name.split('/');
          const file = segments.pop();
          let dir = root;
          for (const segment of segments) dir = await dir.getDirectoryHandle(segment, { create: true });
          const handle = await dir.getFileHandle(file, { create: true });
          const writable = await handle.createWritable();
          await writable.write(new Uint8Array(values));
          await writable.close();
        }
        await root.getDirectoryHandle('output', { create: true });
      }, { files: Object.fromEntries(Object.entries(fixtures).map(([name, data]) => [`content/${name}`, [...data]])) });
    });

    let backupName = null;

    await test('creates a backup from the folder dialog', async () => {
      await menuCommand(page, 'file', 'create-backup');
      await page.waitForSelector('#modal-dialog[open]');
      await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        window.__pxPickers.push(await root.getDirectoryHandle('content'));
      });
      await page.click('#cb-content');
      await page.waitForFunction(() => document.querySelector('#cb-content-name')?.textContent === 'content');
      await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        window.__pxPickers.push(await root.getDirectoryHandle('output'));
      });
      await page.click('#cb-output');
      await page.waitForFunction(() => document.querySelector('#cb-output-name')?.textContent === 'output');
      await page.click('#modal-foot button.primary');
      await logHas(page, 'Created a new backup in');

      backupName = await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const output = await root.getDirectoryHandle('output');
        for await (const [name, handle] of output.entries()) {
          if (handle.kind === 'directory') return name;
        }
        return null;
      });
      assert(backupName, 'a backup directory was created');
    });

    await test('opens the backup folder into the file browser', async () => {
      await page.evaluate(async name => {
        const root = await navigator.storage.getDirectory();
        const output = await root.getDirectoryHandle('output');
        window.__pxPickers.push(await output.getDirectoryHandle(name));
      }, backupName);
      await page.click('#open-button');
      await page.waitForFunction(() => document.querySelectorAll('.explorer-row[data-path]').length > 0, null, { timeout: 60000 });
      await page.waitForSelector('#empty-state', { state: 'hidden' });

      const top = await rows(page);
      for (const wanted of ['/dev_hdd0', '/dev_flash2']) assert(top.includes(wanted), `index lists ${wanted}`);

      const summary = await page.textContent('#summary');
      assert(summary.includes('Backup ID'), 'summary shows the backup id');
      assertEquals(await page.isEnabled('#write-button'), true, 'write is enabled');
      assertEquals(await page.isEnabled('#download-button'), true, 'download is enabled');
    });

    await test('finds the backup when the parent folder is picked', async () => {
      await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        window.__pxPickers.push(await root.getDirectoryHandle('output'));
      });
      await page.click('#open-button');
      await logHas(page, 'No archive.dat here; opening the backup in');
      await page.waitForFunction(() => document.querySelectorAll('.explorer-row[data-path]').length > 0, null, { timeout: 60000 });
      const top = await rows(page);
      assert(top.includes('/dev_hdd0'), 'the nested backup folder was opened');
    });

    await test('navigates with breadcrumbs and the history buttons', async () => {
      await page.dblclick('.explorer-row[data-path="/dev_hdd0"]');
      await page.waitForFunction(() => [...document.querySelectorAll('.crumb')].some(node => node.textContent.trim() === 'dev_hdd0'));

      await page.click('#nav-back');
      await page.waitForFunction(name => [...document.querySelectorAll('.crumb')].some(node => node.textContent.includes(name)), backupName);
      assert((await rows(page)).includes('/dev_flash2'), 'back returns to the backup root');

      await page.click('#nav-forward');
      await page.waitForFunction(() => [...document.querySelectorAll('.crumb')].some(node => node.textContent.trim() === 'dev_hdd0'));
      await page.click('#nav-up');
      await page.waitForFunction(() => ![...document.querySelectorAll('.crumb')].some(node => node.textContent.trim() === 'dev_hdd0'));

      await navigateTo(page, '/dev_flash2/etc');
      assert((await rows(page)).includes('/dev_flash2/etc/note.txt'), 'path bar navigates deep');
      await page.click('#nav-home');
      await page.waitForFunction(() => [...document.querySelectorAll('.crumb')].length === 1);
    });

    await test('edits a text file with the built-in editor', async () => {
      await navigateTo(page, '/dev_flash2/etc');
      await openEditorFor(page, '/dev_flash2/etc/note.txt');
      const original = await page.inputValue('#editor-text');
      assert(original.startsWith('ps3xport wasm browser test'), 'editor shows the original text');
      await page.fill('#editor-text', editedNote);
      await page.click('#editor-save');
      await page.waitForSelector('#editor-dialog', { state: 'hidden' });
      await logHas(page, 'updated in the working copy');
      await page.waitForFunction(() => [...document.querySelectorAll('.badge.dirty')].length > 0);
      assert((await page.textContent('#browser-usage')).includes('unsaved change'), 'status reports unsaved changes');
    });

    await test('creates folders and files in the working copy', async () => {
      await page.click('#nav-home');
      await page.waitForFunction(() => [...document.querySelectorAll('.crumb')].length === 1);
      await menuCommand(page, 'edit', 'new-folder');
      await page.waitForSelector('#prompt-value');
      await page.fill('#prompt-value', 'extra');
      await page.click('#modal-foot button.primary');
      await page.waitForSelector('.explorer-row[data-path="/extra"]');

      await page.dblclick('.explorer-row[data-path="/extra"]');
      await page.waitForFunction(() => [...document.querySelectorAll('.crumb')].some(node => node.textContent.trim() === 'extra'));

      await menuCommand(page, 'edit', 'new-file');
      await page.waitForSelector('#prompt-value');
      await page.fill('#prompt-value', 'hello.txt');
      await page.click('#modal-foot button.primary');
      await page.waitForSelector('#editor-dialog[open]');
      await page.fill('#editor-text', 'hello world\n');
      await page.click('#editor-save');
      await page.waitForSelector('#editor-dialog', { state: 'hidden' });
      await page.waitForSelector('.explorer-row[data-path="/extra/hello.txt"]');
    });

    await test('imports a file into the current folder', async () => {
      const payload = pattern(96 * 1024, 199);
      await page.setInputFiles('#file-input', {
        name: 'imported.bin',
        mimeType: 'application/octet-stream',
        buffer: payload,
      });
      await page.waitForSelector('.explorer-row[data-path="/extra/imported.bin"]');
      await page.click('.explorer-row[data-path="/extra/imported.bin"]');
      await page.keyboard.press('Delete');
      await page.waitForSelector('#modal-dialog[open]');
      await page.click('#modal-foot button.danger');
      await page.waitForFunction(() => !document.querySelector('.explorer-row[data-path="/extra/imported.bin"]'));

      const names = await rows(page);
      assert(names.includes('/extra/hello.txt'), 'the remaining files are untouched');
    });

    let downloaded = null;

    await test('downloads the working copy as a zip', async () => {
      downloaded = await waitForDownload(page);
      const entries = await zipContents(downloaded);
      const note = Buffer.from(entries.get('dev_flash2/etc/note.txt')).toString('utf8');
      assertEquals(note, editedNote, 'edited text is in the zip');
      assertEquals(Buffer.from(entries.get('extra/hello.txt')).toString('utf8'), 'hello world\n', 'new file is in the zip');
      const eboot = crypto.createHash('sha256').update(entries.get('dev_hdd0/game/TEST/USRDIR/EBOOT.BIN')).digest('hex');
      assertEquals(eboot, expectedHashes['/dev_hdd0/game/TEST/USRDIR/EBOOT.BIN'], 'binary content is preserved');
      const save = crypto.createHash('sha256').update(entries.get('dev_hdd0/home/00000001/savedata/GAME1/SAVE.DAT')).digest('hex');
      assertEquals(save, expectedHashes['/dev_hdd0/home/00000001/savedata/GAME1/SAVE.DAT'], 'second binary content is preserved');
      assert(!entries.has('extra/imported.bin'), 'deleted file is not in the zip');
    });

    await test('writes the working copy back to the backup folder', async () => {
      await page.click('#write-button');
      await page.waitForSelector('#modal-dialog[open]');
      await page.click('#modal-foot button.danger');
      await logHasTimes(page, 'Wrote', 1);
      await logHasTimes(page, 'Reloading the new backup finished', 1);
      await page.waitForFunction(() => document.querySelectorAll('.explorer-row[data-path]').length > 0);

      const top = await rows(page);
      assert(top.includes('/extra'), 'new folder is part of the rebuilt backup');

      const leftovers = await page.evaluate(async name => {
        const root = await navigator.storage.getDirectory();
        const output = await root.getDirectoryHandle('output');
        const backup = await output.getDirectoryHandle(name);
        const names = [];
        for await (const [entryName, handle] of backup.entries()) names.push(`${handle.kind}:${entryName}`);
        return names;
      }, backupName);
      assert(leftovers.some(name => name === 'file:archive.dat'), 'archive.dat was rebuilt');
      assert(!leftovers.some(name => name.startsWith('directory:.ps3xport')), 'temporary folders were cleaned up');
      assert(!leftovers.some(name => name.endsWith('.bak')), 'no .bak files are left behind');
    });

    await test('the rebuilt archive contains the edited and added files', async () => {
      await navigateTo(page, '/dev_flash2/etc');
      await openEditorFor(page, '/dev_flash2/etc/note.txt');
      assertEquals(await page.inputValue('#editor-text'), editedNote, 'edited text survived the rebuild');
      await page.click('#editor-cancel');
      await page.waitForSelector('#editor-dialog', { state: 'hidden' });

      const names = await rows(page);
      assert(names.includes('/dev_flash2/etc/note.txt'), 'edited file is still listed');

      const rebuilt = await waitForDownload(page);
      const entries = await zipContents(rebuilt);
      assertEquals(Buffer.from(entries.get('extra/hello.txt')).toString('utf8'), 'hello world\n', 'added file survived the rebuild');
      const eboot = crypto.createHash('sha256').update(entries.get('dev_hdd0/game/TEST/USRDIR/EBOOT.BIN')).digest('hex');
      assertEquals(eboot, expectedHashes['/dev_hdd0/game/TEST/USRDIR/EBOOT.BIN'], 'binary content survived the rebuild');
    });

    await test('advanced mode is off by default and can be enabled in settings', async () => {
      await menuCommand(page, 'view', 'settings');
      await page.waitForSelector('#set-advanced');
      assert(!(await page.isChecked('#set-advanced')), 'advanced mode defaults to off');
      assert(await page.isDisabled('#set-device'), 'device id is disabled while advanced mode is off');
      await page.check('#set-advanced');
      assert(await page.isEnabled('#set-device'), 'device id becomes editable');
      await page.click('#modal-foot button.secondary');
      await page.waitForSelector('#modal-dialog', { state: 'hidden' });
    });

    await test('replaces the working copy with another folder', async () => {
      await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle('content2', { create: true });
        const hdd = await dir.getDirectoryHandle('dev_hdd0', { create: true });
        const handle = await hdd.getFileHandle('replacement.txt', { create: true });
        const writable = await handle.createWritable();
        await writable.write(new TextEncoder().encode('replacement content\n'));
        await writable.close();
        window.__pxPickers.push(await root.getDirectoryHandle('content2'));
      });

      await menuCommand(page, 'file', 'replace-folder');
      await page.waitForFunction(() => document.querySelector('#summary')?.textContent.includes('Content tree'), null, { timeout: 60000 });
      const list = await rows(page);
      assert(list.includes('/dev_hdd0'), 'replacement folder is browsable');
      await page.dblclick('.explorer-row[data-path="/dev_hdd0"]');
      await page.waitForSelector('.explorer-row[data-path="/dev_hdd0/replacement.txt"]');
      await page.click('#nav-home');
      await page.waitForFunction(() => [...document.querySelectorAll('.crumb')].length === 1);
    });

    await test('opening a zip file works end to end', async () => {
      await page.setInputFiles('#zip-input', downloaded);
      await page.waitForFunction(() => document.querySelector('#summary')?.textContent.includes('Zip ·'), null, { timeout: 60000 });
      await page.waitForFunction(() => document.querySelectorAll('.explorer-row[data-path]').length > 0, null, { timeout: 60000 });
      const top = await rows(page);
      assert(top.includes('/dev_hdd0'), 'zip contents are browsable');
      await navigateTo(page, '/dev_flash2/etc');
      await openEditorFor(page, '/dev_flash2/etc/note.txt');
      assertEquals(await page.inputValue('#editor-text'), editedNote, 'zip file content is readable');
      await page.click('#editor-cancel');
    });

    assert(consoleErrors.length === 0, `no console errors: ${consoleErrors.join(' | ')}`);
    await test('writes a backup that came from a zip file', async () => {
      const zipPath = path.join(os.tmpdir(), `ps3xport-backup-${Date.now()}.zip`);
      const base64 = await page.evaluate(async name => {
        const { buildZip } = await import('./zip.js');
        const root = await navigator.storage.getDirectory();
        const output = await root.getDirectoryHandle('output');
        const backup = await output.getDirectoryHandle(name);
        const entries = [];
        async function walk(dir, prefix) {
          for await (const [entryName, handle] of dir.entries()) {
            const entryPath = `${prefix}/${entryName}`;
            if (handle.kind === 'directory') {
              await walk(handle, entryPath);
            } else {
              const file = await handle.getFile();
              entries.push({ path: entryPath, mtime: new Date(file.lastModified), getBlob: async () => file });
            }
          }
        }
        await walk(backup, '');
        const { blob } = await buildZip(entries, {});
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 8192) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        }
        return btoa(binary);
      }, backupName);
      await fs.promises.writeFile(zipPath, Buffer.from(base64, 'base64'));

      await page.setInputFiles('#zip-input', zipPath);
      await page.waitForFunction(
        () => [...document.querySelectorAll('.explorer-row[data-path]')].some(node => node.dataset.path === '/dev_hdd0'),
        null,
        { timeout: 120000 },
      );
      const top = await rows(page);
      assert(top.includes('/dev_hdd0'), 'the zipped backup is browsable');

      await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        await root.getDirectoryHandle('device', { create: true });
        window.__pxPickers.push(await root.getDirectoryHandle('device'));
      });
      await page.click('#write-button');
      await page.waitForSelector('#modal-dialog[open]');
      await page.click('#modal-foot button.danger');
      await logHasTimes(page, 'Wrote', 2);
      await logHasTimes(page, 'Reloading the new backup finished', 2);

      const written = await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const device = await root.getDirectoryHandle('device');
        const names = [];
        for await (const [name, handle] of device.entries()) names.push(`${handle.kind}:${name}`);
        return names;
      });
      assert(written.includes('file:archive.dat'), 'the archive was rebuilt from the zip');
      assert(!written.some(name => name.startsWith('directory:.ps3xport')), 'temporary folders were cleaned up');
    });
    await test('selects multiple items and shows their properties', async () => {
      await page.click('#nav-home');
      await page.waitForFunction(() => [...document.querySelectorAll('.crumb')].length === 1);
      const top = await rows(page);
      assert(top.length >= 2, 'at least two top-level entries');
      await page.click(`.explorer-row[data-path="${top[0]}"]`);
      await page.click(`.explorer-row[data-path="${top[1]}"]`, { modifiers: ['Control'] });
      await menuCommand(page, 'edit', 'properties');
      await page.waitForSelector('#modal-dialog[open]');
      await page.waitForFunction(() => document.querySelector('#modal-body')?.textContent.includes('Total size'));
      const text = await page.textContent('#modal-body');
      assert(text.includes('Files'), 'properties list the file count');
      assert(text.includes('Stored in'), 'properties list the archive chunks');
      await page.click('#modal-foot button.primary');
    });

    await test('unlinks a file and writes without a dialog when Shift is held', async () => {
      await navigateTo(page, '/extra');
      await page.click('.explorer-row[data-path="/extra/hello.txt"]');
      await menuCommand(page, 'edit', 'delete-unlink');
      await page.waitForFunction(() => !document.querySelector('.explorer-row[data-path="/extra/hello.txt"]'));
      await logHas(page, 'Unlinked /extra/hello.txt');

      await page.keyboard.down('Shift');
      await page.click('#write-button');
      await page.keyboard.up('Shift');
      await logHas(page, 'Write confirmation skipped with Shift');
      await logHasTimes(page, 'Reloading the new backup finished', 3);
      await page.waitForFunction(() => document.querySelector('#app-status')?.textContent === 'Ready', null, { timeout: 120000 });
      await navigateTo(page, '/extra');
      const names = await rows(page);
      assert(!names.includes('/extra/hello.txt'), 'the unlinked file is gone');
    });

    await test('shows unlinked data and compacts it', async () => {
      await menuCommand(page, 'view', 'show-details');
      await page.waitForSelector('#modal-dialog[open]');
      await page.waitForFunction(() => document.querySelector('#modal-body')?.textContent.includes('Unlinked'));
      await page.click('#modal-foot button.primary');

      await menuCommand(page, 'view', 'compact');
      await page.waitForFunction(() => document.querySelector('#modal-title')?.textContent === 'Compact unlinked data');
      await page.click('#modal-foot button.danger');
      await page.waitForFunction(() => document.querySelector('#modal-title')?.textContent === 'Write to device');
      const planText = await page.textContent('#modal-body');
      assert(planText.includes('Chunks written'), 'the plan lists the chunks to write');
      assert(planText.includes('Estimated time'), 'the plan shows an estimate');
      await page.click('#modal-foot button.danger');
      await logHasTimes(page, 'Reloading the new backup finished', 4);
      await page.waitForFunction(() => document.querySelector('#app-status')?.textContent === 'Ready', null, { timeout: 120000 });

      await menuCommand(page, 'view', 'show-details');
      await page.waitForSelector('#modal-dialog[open]');
      const details = await page.textContent('#modal-body');
      assert(!details.includes('Unlinked'), 'the tombstones were compacted');
      await page.click('#modal-foot button.primary');
    });

    await test('has an installable manifest and an offline cache', async () => {
      const manifest = await page.evaluate(async () => (await fetch('./manifest.webmanifest')).json());
      assertEquals(manifest.short_name, 'ps3xport', 'manifest short name');
      assert(manifest.icons.length >= 2, 'manifest has icons');
      const registered = await page.evaluate(async () => {
        if (!('serviceWorker' in navigator)) return false;
        const registration = await navigator.serviceWorker.getRegistration();
        return Boolean(registration);
      });
      assert(registered, 'service worker is registered');
      const canonical = await page.getAttribute('link[rel="canonical"]', 'href');
      assertEquals(canonical, 'https://kiwifruitdev.com/apps/ps3xport-wasm', 'canonical url');
    });

  } finally {
    if (process.env.PXFS_DEBUG) {
      console.log((await page.textContent('#log').catch(() => ''))?.trim());
      console.log(`--- status: ${await page.textContent('#app-status').catch(() => '?')}`);
    }
    await browser.close();
    server.kill();
  }

  if (failures > 0) {
    console.log(`\n${failures} test(s) failed, ${passes} passed.`);
    process.exit(1);
  }
  console.log(`\nAll ${passes} browser tests passed.`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
