// Browser end-to-end test: drives the real UI in Chrome through the File System
// Access API (backed by OPFS so it can run unattended).
//
//   node test/browser-test.mjs
//
// Requires Google Chrome or Microsoft Edge to be installed (channel "chrome",
// falling back to "msedge").

import crypto from 'node:crypto';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

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

async function test(name, fn) {
  try {
    await fn();
    passes++;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures++;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error.message}`);
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
  'dev_flash2/etc/note.txt': Buffer.from('ps3export wasm browser test\n'),
};

const expectedHashes = Object.fromEntries(Object.entries(fixtures).map(([name, data]) => [
  `/${name}`,
  crypto.createHash('sha256').update(data).digest('hex'),
]));

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

async function main() {
  port = await findFreePort();
  baseUrl = `http://localhost:${port}/`;
  const server = await startServer();
  const browser = await launch();
  const context = await browser.newContext();
  const page = await context.newPage();
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
        await root.getDirectoryHandle('extract', { create: true });
        await root.getDirectoryHandle('single', { create: true });
      }, { files: Object.fromEntries(Object.entries(fixtures).map(([name, data]) => [`content/${name}`, [...data]])) });
    });

    await test('creates a backup from the content folder through the UI', async () => {
      await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        window.__pxPickers.push(await root.getDirectoryHandle('content'));
        window.__pxPickers.push(await root.getDirectoryHandle('output'));
      });
      await page.click('#choose-content');
      await page.waitForFunction(() => document.querySelector('#content-name')?.textContent === 'content');
      await page.click('#choose-out');
      await page.waitForFunction(() => document.querySelector('#out-name')?.textContent === 'output');
      await page.waitForFunction(() => !document.querySelector('#create-backup').disabled);
      await page.click('#create-backup');
      await page.waitForFunction(() => [...document.querySelectorAll('#log span')].some(node => node.textContent.includes('Creating backup') && node.textContent.includes('finished')), null, { timeout: 60000 });
    });

    let backupName = null;

    await test('opens the created backup and lists its contents', async () => {
      backupName = await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const output = await root.getDirectoryHandle('output');
        for await (const [name, handle] of output.entries()) {
          if (handle.kind === 'directory') return name;
        }
        return null;
      });
      assert(backupName, 'a backup directory was created');

      await page.evaluate(async name => {
        const root = await navigator.storage.getDirectory();
        const output = await root.getDirectoryHandle('output');
        window.__pxPickers.push(await output.getDirectoryHandle(name));
      }, backupName);
      await page.click('#choose-backup');
      await page.waitForSelector('#contents-panel:not([hidden])');
      await page.waitForFunction(() => document.querySelectorAll('#file-list tr[data-path]').length > 0);

      const rows = await page.$$eval('#file-list tr[data-path]', nodes => nodes.map(node => node.dataset.path));
      for (const wanted of Object.keys(expectedHashes)) assert(rows.includes(wanted), `index lists ${wanted}`);

      const summary = await page.textContent('#index-summary');
      assert(summary.includes('Backup ID'), 'index summary shows the backup id');
    });

    await test('extracts every file from the browser and verifies hashes', async () => {
      await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        window.__pxPickers.push(await root.getDirectoryHandle('extract'));
      });
      await page.click('#choose-out');
      await page.waitForFunction(() => document.querySelector('#out-name')?.textContent === 'extract');
      await page.click('#extract-all');
      await page.waitForFunction(() => [...document.querySelectorAll('#log span')].some(node => node.textContent.includes('Extraction complete')), null, { timeout: 60000 });

      const hashes = await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const base = await root.getDirectoryHandle('extract');
        const digest = async (path) => {
          let dir = base;
          const segments = path.split('/').filter(Boolean);
          const file = segments.pop();
          for (const segment of segments) dir = await dir.getDirectoryHandle(segment);
          const handle = await dir.getFileHandle(file);
          const fileData = await handle.getFile();
          const buffer = await fileData.arrayBuffer();
          const hash = await crypto.subtle.digest('SHA-256', buffer);
          return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
        };
        const result = {};
        for (const name of ['dev_hdd0/home/00000001/savedata/GAME1/SAVE.DAT', 'dev_hdd0/game/TEST/USRDIR/EBOOT.BIN', 'dev_flash2/etc/note.txt']) {
          result['/' + name] = await digest(name);
        }
        return result;
      });

      for (const [name, hash] of Object.entries(expectedHashes)) {
        assertEquals(hashes[name], hash, `sha256 of ${name}`);
      }
    });

    await test('extracts a single selected file', async () => {
      const target = '/dev_hdd0/game/TEST/USRDIR/EBOOT.BIN';
      await page.click(`#file-list tr[data-path="${target}"]`);
      await page.waitForFunction(() => !document.querySelector('#extract-selected').disabled);
      await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        window.__pxPickers.push(await root.getDirectoryHandle('single'));
      });
      await page.click('#choose-out');
      await page.waitForFunction(() => document.querySelector('#out-name')?.textContent === 'single');
      await page.click('#extract-selected');
      await page.waitForFunction(() => [...document.querySelectorAll('#log span')].some(node => node.textContent.includes('Extracted to the output folder')), null, { timeout: 60000 });

      const hash = await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        let dir = await root.getDirectoryHandle('single');
        for (const segment of ['dev_hdd0', 'game', 'TEST', 'USRDIR']) dir = await dir.getDirectoryHandle(segment);
        const handle = await dir.getFileHandle('EBOOT.BIN');
        const buffer = await (await handle.getFile()).arrayBuffer();
        const digest = await crypto.subtle.digest('SHA-256', buffer);
        return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
      });
      assertEquals(hash, expectedHashes[target], 'single file hash');
    });

    await test('appends a content folder to the open backup', async () => {
      const extra = pattern(220 * 1024, 241);
      const extraHash = crypto.createHash('sha256').update(extra).digest('hex');
      await page.evaluate(async values => {
        const root = await navigator.storage.getDirectory();
        let dir = await root.getDirectoryHandle('content2', { create: true });
        for (const segment of ['dev_hdd0', 'extra']) dir = await dir.getDirectoryHandle(segment, { create: true });
        const handle = await dir.getFileHandle('EXTRA.DAT', { create: true });
        const writable = await handle.createWritable();
        await writable.write(new Uint8Array(values));
        await writable.close();
        window.__pxPickers.push(await root.getDirectoryHandle('content2'));
      }, [...extra]);

      await page.click('#choose-content');
      await page.waitForFunction(() => document.querySelector('#content-name')?.textContent === 'content2');
      await page.waitForFunction(() => !document.querySelector('#add-content').disabled);
      await page.click('#add-content');
      await page.waitForFunction(() => [...document.querySelectorAll('#log span')].some(node => node.textContent.includes('Content added')), null, { timeout: 120000 });
      await page.waitForSelector('#file-list tr[data-path="/dev_hdd0/extra/EXTRA.DAT"]');

      // The appended segment must be readable end to end.
      await page.click('#file-list tr[data-path="/dev_hdd0/extra/EXTRA.DAT"]');
      await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        window.__pxPickers.push(await root.getDirectoryHandle('extra-out', { create: true }));
      });
      await page.click('#choose-out');
      await page.waitForFunction(() => document.querySelector('#out-name')?.textContent === 'extra-out');
      await page.click('#extract-selected');
      await page.waitForFunction(() => [...document.querySelectorAll('#log span')].filter(node => node.textContent.includes('Extracted to the output folder')).length >= 2, null, { timeout: 60000 });

      const hash = await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        let dir = await root.getDirectoryHandle('extra-out');
        for (const segment of ['dev_hdd0', 'extra']) dir = await dir.getDirectoryHandle(segment);
        const buffer = await (await (await dir.getFileHandle('EXTRA.DAT')).getFile()).arrayBuffer();
        const digest = await crypto.subtle.digest('SHA-256', buffer);
        return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
      });
      assertEquals(hash, extraHash, 'appended file hash');
    });

    await test('deletes a file from the index (rewrites archive.dat in place)', async () => {
      const before = await page.$$eval('#file-list tr[data-path]', nodes => nodes.length);
      await page.click('#file-list tr[data-path="/dev_hdd0/extra/EXTRA.DAT"]');
      await page.waitForFunction(() => document.querySelector('#file-list tr[data-path="/dev_hdd0/extra/EXTRA.DAT"]').classList.contains('selected'));
      await page.click('#delete-selected');
      await page.waitForFunction(() => [...document.querySelectorAll('#log span')].some(node => node.textContent.includes('from the index') && node.textContent.includes('finished')), null, { timeout: 60000 });

      const paths = await page.$$eval('#file-list tr[data-path]', nodes => nodes.map(node => node.dataset.path));
      assertEquals(paths.length, before, 'entry count unchanged');
      assert(paths.includes('/dev_hdd0/tmp/null'), 'entry redirected to /dev_hdd0/tmp/null');
      assert(!paths.includes('/dev_hdd0/extra/EXTRA.DAT'), 'file no longer listed');

      // The index must still be valid after the in-place rewrite.
      await page.evaluate(async name => {
        const root = await navigator.storage.getDirectory();
        const output = await root.getDirectoryHandle('output');
        window.__pxPickers.push(await output.getDirectoryHandle(name));
      }, backupName);
      await page.click('#choose-backup');
      await page.waitForFunction(() => [...document.querySelectorAll('#log span')].filter(node => node.textContent.includes('archive.dat:')).length >= 2);
    });

    await test('filters the file list', async () => {
      const total = await page.$$eval('#file-list tr[data-path]', nodes => nodes.length);
      await page.fill('#filter', 'EBOOT');
      await page.waitForFunction(() => document.querySelectorAll('#file-list tr[data-path]').length === 1);
      await page.fill('#filter', '');
      await page.waitForFunction(count => document.querySelectorAll('#file-list tr[data-path]').length === count, total);
    });

    await test('produced no console errors', async () => {
      const relevant = consoleErrors.filter(message => !message.includes('favicon'));
      assertEquals(relevant.length, 0, `console errors: ${relevant.join(' | ')}`);
    });
  } finally {
    console.log('--- app activity log ---');
    console.log((await page.textContent('#log').catch(() => ''))?.trim());
    console.log(`--- status: ${await page.textContent('#app-status').catch(() => '?')}`);
    await browser.close();
    server.kill();
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
