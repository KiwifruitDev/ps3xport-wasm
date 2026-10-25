// Tests the browser code path: web/worker.js running in a worker thread, with
// pxfs.js + host-remote.js + sync-bridge.js driving a real directory through
// the same synchronous SharedArrayBuffer bridge the browser uses.
//
//   node test/bridge-tests.mjs

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import { createBridgeServer, DATA_BYTES, HEADER_BYTES } from '../web/sync-bridge.js';
import { NodeHost } from './node-host.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpRoot = path.join(here, '.tmp-bridge');
const contentDir = path.join(tmpRoot, 'content');
const outDir = path.join(tmpRoot, 'out');

let failures = 0;
let passes = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEquals(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, got ${actual}`);
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

function writeRandom(file, size) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const buffer = crypto.randomBytes(size);
  fs.writeFileSync(file, buffer);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function main() {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(contentDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  const expected = new Map();
  expected.set('/dev_hdd0/home/00000001/savedata/GAME2/SAVE.BIN', writeRandom(path.join(contentDir, 'dev_hdd0/home/00000001/savedata/GAME2/SAVE.BIN'), 250 * 1024));
  expected.set('/dev_hdd0/game/BRIDGE/USRDIR/DATA.PKG', writeRandom(path.join(contentDir, 'dev_hdd0/game/BRIDGE/USRDIR/DATA.PKG'), 3 * 1024 * 1024 + 123));
  expected.set('/dev_flash2/etc/readme.txt', writeRandom(path.join(contentDir, 'dev_flash2/etc/readme.txt'), 5));

  const sab = new SharedArrayBuffer(HEADER_BYTES + DATA_BYTES);
  const bridge = createBridgeServer(sab, DATA_BYTES);
  const host = new NodeHost();
  host.setRoot('content', contentDir);
  host.setRoot('out', outDir);

  const worker = new Worker(new URL('./node-worker-adapter.mjs', import.meta.url));
  const pending = new Map();
  let nextId = 1;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  worker.on('error', rejectReady);
  worker.on('message', async message => {
    if (!message || typeof message !== 'object') return;

    if (message.type === 'io') {
      await bridge(message, (request, data) => host.dispatch(request.op, request.args, data));
      return;
    }
    if (message.type === 'ready') {
      resolveReady();
      return;
    }
    if (message.type === 'fatal') {
      rejectReady(new Error(message.error));
      return;
    }
    if (message.type === 'rpc-result' || message.type === 'mount-result') {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.ok) entry.resolve(message.result ?? {});
      else entry.reject(new Error(message.error));
    }
  });

  worker.postMessage({ type: 'init', sab });
  await ready;

  const mount = name => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    worker.postMessage({ type: 'mount', id, name });
  });

  const rpc = (cmd, args = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    worker.postMessage({ type: 'rpc', id, cmd, args });
  });

  try {
    await mount('content');
    await mount('out');

    await test('creates a backup through the worker bridge', async () => {
      await rpc('createBackup', { dir: '/px/out/backup', content: '/px/content', protectedContent: '-' });
      assert(fs.existsSync(path.join(outDir, 'backup', 'archive.dat')), 'archive.dat written');
      assert(fs.existsSync(path.join(outDir, 'backup', 'archive_00.dat')), 'archive_00.dat written');
    });

    host.setRoot('backup', path.join(outDir, 'backup'));
    await mount('backup');

    await test('lists the index through the worker bridge', async () => {
      const index = await rpc('listIndex', { path: '/px/backup/archive.dat' });
      assertEquals(index.files.length, expected.size, 'file count');
      assertEquals(index.archiveType, 5, 'archive type');
      const paths = new Set(index.files.map(file => file.path));
      for (const wanted of expected.keys()) assert(paths.has(wanted), `index contains ${wanted}`);
    });

    await test('extracts every file through the worker bridge', async () => {
      await rpc('extractAll', { dir: '/px/backup', prefix: 'archive', outdir: '/px/out/extract' });
      for (const [virtualPath, digest] of expected) {
        const extracted = path.join(outDir, 'extract', ...virtualPath.split('/').filter(Boolean));
        assertEquals(hashFile(extracted), digest, `content of ${virtualPath}`);
      }
    });

    await test('extracts one file through the worker bridge', async () => {
      await rpc('extractFile', {
        dir: '/px/backup',
        prefix: 'archive',
        filename: '/dev_hdd0/game/BRIDGE/USRDIR/DATA.PKG',
        out: '/px/out/one/DATA.PKG',
      });
      assertEquals(hashFile(path.join(outDir, 'one', 'DATA.PKG')), expected.get('/dev_hdd0/game/BRIDGE/USRDIR/DATA.PKG'), 'single file hash');
    });

    await test('decrypts the index through the worker bridge', async () => {
      await rpc('decrypt', { input: '/px/backup/archive.dat', output: '/px/out/archive.dec' });
      assert(fs.existsSync(path.join(outDir, 'archive.dec')), 'decrypted file exists');
    });

    await test('reports errors instead of trapping', async () => {
      let message = '';
      try {
        await rpc('listIndex', { path: '/px/backup/missing.dat' });
      } catch (error) {
        message = error.message;
      }
      assert(message.length > 0, 'an error message is returned');
      // The worker must still be usable after a failed call.
      const index = await rpc('listIndex', { path: '/px/backup/archive.dat' });
      assertEquals(index.files.length, expected.size, 'worker still works');
    });

    await test('large files stream correctly (>3 MiB, multi-chunk)', async () => {
      const source = path.join(outDir, 'extract', 'dev_hdd0', 'game', 'BRIDGE', 'USRDIR', 'DATA.PKG');
      const size = fs.statSync(source).size;
      assert(size > 3 * 1024 * 1024, 'test file is large enough');
      assertEquals(hashFile(source), expected.get('/dev_hdd0/game/BRIDGE/USRDIR/DATA.PKG'), 'no corruption across chunk boundaries');
    });
  } finally {
    await worker.terminate();
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
