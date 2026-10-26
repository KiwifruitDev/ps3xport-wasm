// Tests the incremental writer end to end: layout mapping, chunk rewriting,
// index editing, and the chunk-size invariant (every chunk but the last is
// exactly the chunk capacity). A small chunk capacity is used so the tests
// exercise multi-chunk files without needing 4 GiB chunks.
//
//   node test/incremental-tests.mjs

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import { createBridgeServer, DATA_BYTES, HEADER_BYTES } from '../web/sync-bridge.js';
import { NodeHost } from './node-host.mjs';
import {
  CHUNK_HEADER, chunkName, layoutArchive, planArchive,
} from '../web/layout.js';
import { beginIndex, applyIndex, closeIndex, writePlanChunks } from '../web/writer.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpRoot = path.join(here, '.tmp-incremental');
const contentDir = path.join(tmpRoot, 'content');
const backupDir = path.join(tmpRoot, 'backup');
const outDir = path.join(tmpRoot, 'out');
const extractDir = path.join(tmpRoot, 'extract');
const CAP = 4096;
const DIRS = [
  { path: '/dev_hdd0', mode: 0x41FF, mtime: 1700000000, flags: 1 },
  { path: '/dev_flash2', mode: 0x41FF, mtime: 1700000000, flags: 3 },
];

let failures = 0;
let passes = 0;

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
    console.log(`       ${error.stack ?? error.message}`);
  }
}

function writeFile(relative, buffer) {
  const file = path.join(contentDir, ...relative.split('/').filter(Boolean));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buffer);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function pattern(length, seed) {
  const buffer = Buffer.alloc(length);
  for (let i = 0; i < length; i++) buffer[i] = (i * 31 + seed * 17 + (i % 7)) % 251;
  return buffer;
}

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function listFiles(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listFiles(path.join(dir, entry.name), relative));
    else out.push(relative);
  }
  return out;
}

function chunkSizes(prefix) {
  const sizes = [];
  for (let index = 0; index < 1000; index++) {
    const file = path.join(backupDir, chunkName(prefix, index));
    if (!fs.existsSync(file)) break;
    sizes.push(fs.statSync(file).size);
  }
  return sizes;
}

let extractRoot = extractDir;
let extractSeq = 0;
let testHost = null;
let testMount = null;

async function extractAll(rpc) {
  extractSeq++;
  extractRoot = path.join(tmpRoot, `extract-${extractSeq}`);
  fs.rmSync(extractRoot, { recursive: true, force: true });
  fs.mkdirSync(extractRoot, { recursive: true });
  testHost.setRoot('extract', extractRoot);
  await testMount('extract');
  await rpc('extractAll', { dir: '/px/backup', prefix: 'archive', outdir: '/px/extract' });
}

function extractedHashes() {
  const hashes = new Map();
  for (const relative of listFiles(extractRoot)) {
    hashes.set(relative.slice(1), hashFile(path.join(extractRoot, ...relative.split('/').filter(Boolean))));
  }
  return hashes;
}

function archiveTree(index, blobs) {
  return index.files
    .filter(file => !file.path.startsWith('/dev_hdd0/.ps3xport-unlinked/'))
    .map(file => ({
      path: file.path,
      size: file.size,
      node: {
        type: 'file',
        size: file.size,
        mode: file.mode,
        mtime: new Date((file.mtime ?? Date.now() / 1000) * 1000),
        content: { kind: 'archive', prefix: 'archive', srcPath: file.path },
        originPrefix: 'archive',
        blob: blobs.get(file.path),
      },
    }));
}

async function main() {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(contentDir, { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(extractDir, { recursive: true });

  const expected = new Map();
  expected.set('/dev_flash2/c.bin', writeFile('/dev_flash2/c.bin', pattern(900, 1)));
  expected.set('/dev_hdd0/a.bin', writeFile('/dev_hdd0/a.bin', pattern(700, 2)));
  expected.set('/dev_hdd0/b.bin', writeFile('/dev_hdd0/b.bin', pattern(600, 3)));
  expected.set('/dev_hdd0/large.bin', writeFile('/dev_hdd0/large.bin', pattern(2500, 4)));

  const sab = new SharedArrayBuffer(HEADER_BYTES + DATA_BYTES);
  const bridge = createBridgeServer(sab, DATA_BYTES);
  const host = new NodeHost();
  host.setRoot('content', contentDir);
  host.setRoot('out', outDir);
  host.setRoot('backup', backupDir);
  host.setRoot('extract', extractDir);

  const worker = new Worker(new URL('./node-worker-adapter.mjs', import.meta.url));
  const pending = new Map();
  let nextId = 1;
  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });

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
      console.error(message.error);
      process.exit(1);
    }
    if (message.type === 'rpc-result' || message.type === 'mount-result') {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.ok) entry.resolve(message.result ?? {});
      else entry.reject(new Error(message.error));
    }
  });
  worker.on('error', error => {
    console.error(error);
    process.exit(1);
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
  const engine = { rpc };
  const materialize = async node => {
    if (!node.blob) throw new Error(`unexpected extraction of ${node.path}`);
    return node.blob;
  };

  await mount('content');
  await mount('out');
  await mount('backup');
  await mount('extract');
  testHost = host;
  testMount = mount;

  const commit = (plan) => {
    for (const chunk of plan.rewrites) {
      const name = chunkName(plan.prefix, chunk.index);
      fs.copyFileSync(path.join(outDir, name), path.join(backupDir, name));
    }
    const keep = new Set(plan.rewrites.map(chunk => chunk.index));
    const upto = plan.startSegment ?? plan.layout.chunkCount;
    for (let index = 0; index < Math.min(upto, plan.layout.chunkCount); index++) keep.add(index);
    for (let index = 0; index < 1000; index++) {
      const name = chunkName(plan.prefix, index);
      const file = path.join(backupDir, name);
      if (!fs.existsSync(file)) continue;
      if (!keep.has(index) || plan.deleteChunks.includes(index)) fs.rmSync(file);
    }
    fs.copyFileSync(path.join(outDir, `${plan.prefix}.dat`), path.join(backupDir, `${plan.prefix}.dat`));
  };

  let index = null;
  let id = null;

  await test('writes a fresh archive with small chunks', async () => {
    const files = listFiles(contentDir).map(relative => {
      const blob = fs.readFileSync(path.join(contentDir, ...relative.split('/').filter(Boolean)));
      return {
        path: relative,
        size: blob.length,
        node: { type: 'file', size: blob.length, blob: new Blob([blob]), content: { kind: 'blob' }, originPrefix: 'archive' },
      };
    });
    const plan = planArchive({
      prefix: 'archive',
      index: [],
      layout: layoutArchive([], []),
      treeFiles: files,
      chunkCap: CAP,
    });
    assertEquals(plan.mode, 'append', 'fresh archive mode');
    const dirs = DIRS;
    const opened = await beginIndex({ engine, create: 5 });
    id = opened.id;
    await writePlanChunks({
      plan,
      idHex: opened.id,
      archiveType: 5,
      engine,
      base: '/px/out',
      sourceBase: '/px/out',
      materialize,
    });
    await applyIndex({ plan, engine, saveTo: '/px/out/archive.dat', dirs, archive2Size: null });
    await closeIndex(engine);
    commit(plan);
    index = await rpc('listIndex', { path: '/px/backup/archive.dat' });
    assertEquals(index.files.length, 4, 'file count');
    const sizes = chunkSizes('archive');
    assert(sizes.length >= 2, `more than one chunk (got ${sizes.length})`);
    for (let i = 0; i < sizes.length - 1; i++) assertEquals(sizes[i], CAP, `chunk ${i} is full`);
    await extractAll(rpc);
    const hashes = extractedHashes();
    for (const [file, hash] of expected) assertEquals(hashes.get(file.slice(1)), hash, `content of ${file}`);
    const layout = layoutArchive(index.files, sizes);
    const spans = layout.entries.find(entry => entry.path === '/dev_hdd0/large.bin');
    assert(spans.spanCount >= 2, 'the large file spans chunks');
  });

  await test('appends files by rewriting only the last chunk', async () => {
    const added = pattern(5000, 9);
    const newPath = '/dev_hdd0/added.bin';
    const files = archiveTree(index, new Map());
    files.push({
      path: newPath,
      size: added.length,
      node: { type: 'file', size: added.length, blob: new Blob([added]), content: { kind: 'blob' }, originPrefix: 'archive' },
    });
    const plan = planArchive({
      prefix: 'archive', index: index.files, layout: layoutArchive(index.files, chunkSizes('archive')), treeFiles: files, chunkCap: CAP,
    });
    assertEquals(plan.mode, 'append', 'append mode');
    const first = Math.min(...plan.rewrites.map(chunk => chunk.index));
    assertEquals(first, plan.layout.chunkCount - 1, 'only the last existing chunk is rewritten');
    const opened = await beginIndex({ engine, open: '/px/backup/archive.dat' });
    await writePlanChunks({ plan, idHex: opened.id, archiveType: 5, engine, base: '/px/out', sourceBase: '/px/backup', materialize });
    await applyIndex({ plan, engine, saveTo: '/px/out/archive.dat', dirs: DIRS, archive2Size: null });
    await closeIndex(engine);
    commit(plan);
    index = await rpc('listIndex', { path: '/px/backup/archive.dat' });
    assertEquals(index.files.length, 5, 'file count after append');
    expected.set(newPath, crypto.createHash('sha256').update(added).digest('hex'));
    await extractAll(rpc);
    const hashes = extractedHashes();
    for (const [file, hash] of expected) assertEquals(hashes.get(file.slice(1)), hash, `content of ${file}`);
  });

  await test('renames without touching any data chunk', async () => {
    const from = '/dev_hdd0/a.bin';
    const to = '/dev_hdd0/renamed.bin';
    const files = archiveTree(index, new Map());
    files.find(file => file.path === from).path = to;
    const plan = planArchive({
      prefix: 'archive', index: index.files, layout: layoutArchive(index.files, chunkSizes('archive')), treeFiles: files, chunkCap: CAP,
    });
    assertEquals(plan.mode, 'none', 'rename does not rewrite chunks');
    assertEquals(plan.rewrites.length, 0, 'no chunks rewritten');
    const opened = await beginIndex({ engine, open: '/px/backup/archive.dat' });
    await applyIndex({ plan, engine, saveTo: '/px/out/archive.dat', dirs: DIRS, archive2Size: null });
    await closeIndex(engine);
    commit(plan);
    index = await rpc('listIndex', { path: '/px/backup/archive.dat' });
    assert(index.files.some(file => file.path === to), 'renamed entry exists');
    assert(!index.files.some(file => file.path === from), 'old entry is gone');
    expected.set(to, expected.get(from));
    expected.delete(from);
    await extractAll(rpc);
    const hashes = extractedHashes();
    for (const [file, hash] of expected) assertEquals(hashes.get(file.slice(1)), hash, `content of ${file}`);
  });

  await test('replaces a file with the same size in place', async () => {
    const target = '/dev_hdd0/b.bin';
    const replacement = pattern(600, 42);
    const files = archiveTree(index, new Map());
    const node = files.find(file => file.path === target);
    node.node.content = { kind: 'blob' };
    node.node.blob = new Blob([replacement]);
    const plan = planArchive({
      prefix: 'archive', index: index.files, layout: layoutArchive(index.files, chunkSizes('archive')), treeFiles: files, chunkCap: CAP,
    });
    assertEquals(plan.mode, 'inplace', 'in-place replacement');
    assert(!plan.deleteChunks.length, 'no chunks removed');
    assert(plan.rewrites.every(chunk => chunk.index < plan.layout.chunkCount), 'only existing chunks rewritten');
    const opened = await beginIndex({ engine, open: '/px/backup/archive.dat' });
    await writePlanChunks({ plan, idHex: opened.id, archiveType: 5, engine, base: '/px/out', sourceBase: '/px/backup', materialize });
    await applyIndex({ plan, engine, saveTo: '/px/out/archive.dat', dirs: DIRS, archive2Size: null });
    await closeIndex(engine);
    commit(plan);
    index = await rpc('listIndex', { path: '/px/backup/archive.dat' });
    expected.set(target, crypto.createHash('sha256').update(replacement).digest('hex'));
    await extractAll(rpc);
    const hashes = extractedHashes();
    for (const [file, hash] of expected) assertEquals(hashes.get(file.slice(1)), hash, `content of ${file}`);
  });

  await test('erases a file and rewrites the following chunks', async () => {
    const target = '/dev_hdd0/renamed.bin';
    const files = archiveTree(index, new Map()).filter(file => file.path !== target);
    const plan = planArchive({
      prefix: 'archive', index: index.files, layout: layoutArchive(index.files, chunkSizes('archive')), treeFiles: files, chunkCap: CAP,
    });
    assertEquals(plan.structural, true, 'erase is structural');
    assert(plan.rewrites.length > 0, 'chunks are rewritten');
    const opened = await beginIndex({ engine, open: '/px/backup/archive.dat' });
    await writePlanChunks({ plan, idHex: opened.id, archiveType: 5, engine, base: '/px/out', sourceBase: '/px/backup', materialize });
    await applyIndex({ plan, engine, saveTo: '/px/out/archive.dat', dirs: DIRS, archive2Size: null });
    await closeIndex(engine);
    commit(plan);
    index = await rpc('listIndex', { path: '/px/backup/archive.dat' });
    assert(!index.files.some(file => file.path === target), 'erased entry is gone');
    expected.delete(target);
    await extractAll(rpc);
    const hashes = extractedHashes();
    for (const [file, hash] of expected) assertEquals(hashes.get(file.slice(1)), hash, `content of ${file}`);
    const sizes = chunkSizes('archive');
    for (let i = 0; i < sizes.length - 1; i++) assertEquals(sizes[i], CAP, `chunk ${i} is full`);
  });

  await test('unlinks a file without rewriting data', async () => {
    const target = '/dev_flash2/c.bin';
    const files = archiveTree(index, new Map()).filter(file => file.path !== target);
    const plan = planArchive({
      prefix: 'archive',
      index: index.files,
      layout: layoutArchive(index.files, chunkSizes('archive')),
      treeFiles: files,
      unlink: new Set([target]),
      chunkCap: CAP,
    });
    assertEquals(plan.mode, 'none', 'unlink is index-only');
    assertEquals(plan.rewrites.length, 0, 'no chunk rewrite');
    const opened = await beginIndex({ engine, open: '/px/backup/archive.dat' });
    await applyIndex({ plan, engine, saveTo: '/px/out/archive.dat', dirs: DIRS, archive2Size: null });
    await closeIndex(engine);
    commit(plan);
    index = await rpc('listIndex', { path: '/px/backup/archive.dat' });
    assert(!index.files.some(file => file.path === target), 'unlinked entry is not listed');
    assert(index.files.some(file => file.path.startsWith('/dev_hdd0/.ps3xport-unlinked/')), 'tombstone keeps the layout');
    expected.delete(target);
    await extractAll(rpc);
    const hashes = extractedHashes();
    for (const [file, hash] of expected) assertEquals(hashes.get(file.slice(1)), hash, `content of ${file}`);
  });

  await test('compacts tombstones and reclaims the space', async () => {
    const files = archiveTree(index, new Map());
    const layout = layoutArchive(index.files, chunkSizes('archive'));
    const plan = planArchive({
      prefix: 'archive', index: index.files, layout, treeFiles: files, chunkCap: CAP, compact: true,
    });
    assertEquals(plan.structural, true, 'compaction rewrites the tail');
    const opened = await beginIndex({ engine, open: '/px/backup/archive.dat' });
    await writePlanChunks({ plan, idHex: opened.id, archiveType: 5, engine, base: '/px/out', sourceBase: '/px/backup', materialize });
    await applyIndex({ plan, engine, saveTo: '/px/out/archive.dat', dirs: DIRS, archive2Size: null });
    await closeIndex(engine);
    commit(plan);
    index = await rpc('listIndex', { path: '/px/backup/archive.dat' });
    assert(!index.files.some(file => file.path.startsWith('/dev_hdd0/.ps3xport-unlinked/')), 'tombstones are gone');
    await extractAll(rpc);
    const hashes = extractedHashes();
    for (const [file, hash] of expected) assertEquals(hashes.get(file.slice(1)), hash, `content of ${file}`);
  });

  await test('rejects a plan whose index does not match the chunks', async () => {
    let message = '';
    try {
      layoutArchive([{ path: '/dev_hdd0/too-big.bin', size: 100000 }], [CAP, CAP]);
    } catch (error) {
      message = error.message;
    }
    assert(message.length > 0, 'layout reports the mismatch');
  });

  await worker.terminate();
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
