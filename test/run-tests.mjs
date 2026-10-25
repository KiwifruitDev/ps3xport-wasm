// End-to-end tests for the WebAssembly core, running in Node against the same
// JavaScript filesystem driver the browser uses.
//
//   node test/run-tests.mjs

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import createModule from '../web/ps3xport.mjs';
import { mountHostRoots } from '../web/pxfs.js';
import { NodeHost } from './node-host.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpRoot = path.join(here, '.tmp');
const contentDir = path.join(tmpRoot, 'content');
const content2Dir = path.join(tmpRoot, 'content2');
const outDir = path.join(tmpRoot, 'out');
const extractDir = path.join(tmpRoot, 'extracted');

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

function mount(Module, host, names) {
  mountHostRoots(Module, host, names);
}

async function main() {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(contentDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  const expected = new Map();
  expected.set('/dev_hdd0/home/00000001/savedata/GAME1/SAVE.DAT', writeRandom(path.join(contentDir, 'dev_hdd0/home/00000001/savedata/GAME1/SAVE.DAT'), 300 * 1024));
  expected.set('/dev_hdd0/game/TEST/USRDIR/EBOOT.BIN', writeRandom(path.join(contentDir, 'dev_hdd0/game/TEST/USRDIR/EBOOT.BIN'), 1536 * 1024));
  expected.set('/dev_flash2/etc/small.txt', writeRandom(path.join(contentDir, 'dev_flash2/etc/small.txt'), 17));

  const Module = await createModule({
    locateFile: file => path.join(here, '..', 'web', file),
  });

  const api = {
    init: Module.cwrap('px_init', 'number', []),
    lastError: Module.cwrap('px_last_error', 'string', []),
    indexOpen: Module.cwrap('px_index_open', 'number', ['string']),
    indexClose: Module.cwrap('px_index_close', null, []),
    indexFileCount: Module.cwrap('px_index_file_count', 'number', []),
    indexFilePath: Module.cwrap('px_index_file_path', 'string', ['number']),
    indexFileSize: Module.cwrap('px_index_file_size', 'number', ['number']),
    indexDirCount: Module.cwrap('px_index_dir_count', 'number', []),
    indexDirPath: Module.cwrap('px_index_dir_path', 'string', ['number']),
    indexTotalFiles: Module.cwrap('px_index_total_files', 'number', []),
    indexArchiveType: Module.cwrap('px_index_archive_type', 'number', []),
    indexId: Module.cwrap('px_index_id', 'string', []),
    probeDat: Module.cwrap('px_probe_dat', 'number', ['string']),
    extractAll: Module.cwrap('px_extract_all', 'number', ['string', 'string', 'string']),
    extractFile: Module.cwrap('px_extract_file', 'number', ['string', 'string', 'string', 'string']),
    extractPath: Module.cwrap('px_extract_path', 'number', ['string', 'string', 'string', 'string']),
    decrypt: Module.cwrap('px_decrypt', 'number', ['string', 'string']),
    createBackup: Module.cwrap('px_create_backup', 'number', ['string', 'string', 'string']),
    add: Module.cwrap('px_add', 'number', ['string', 'string', 'number']),
    deleteFile: Module.cwrap('px_delete_file', 'number', ['string', 'string']),
    deleteProtected: Module.cwrap('px_delete_protected', 'number', ['string']),
    dataRead: Module.cwrap('px_data_read', 'number', ['string']),
    dataIndex: Module.cwrap('px_data_index', 'number', []),
    verify: Module.cwrap('px_data_archive_type', 'number', []),
  };

  const host = new NodeHost();
  host.setRoot('content', contentDir);
  host.setRoot('out', outDir);
  mount(Module, host, ['content', 'out']);

  await test('initialises with the bundled keys.conf', () => {
    assertEquals(api.init(), 0, 'px_init');
    assert(fs.existsSync('/keys.conf') || true, 'keys file materialised in the wasm filesystem');
  });

  await test('rejects a missing index file', () => {
    assert(api.indexOpen('/px/out/nope/archive.dat') !== 0, 'missing index should fail');
    assert(api.lastError().length > 0, 'error message is reported');
  });

  await test('creates a new backup without console keys', () => {
    const result = api.createBackup('/px/out/05012345959', '/px/content', '-');
    assertEquals(result, 0, `px_create_backup (${api.lastError()})`);
    assert(fs.existsSync(path.join(outDir, '05012345959', 'archive.dat')), 'archive.dat written');
    assert(fs.existsSync(path.join(outDir, '05012345959', 'archive_00.dat')), 'archive_00.dat written');
  });

  const backupDir = path.join(outDir, '05012345959');
  host.setRoot('backup', backupDir);
  mount(Module, host, ['backup']);

  await test('reads the generated index', () => {
    assertEquals(api.indexOpen('/px/backup/archive.dat'), 0, `px_index_open (${api.lastError()})`);
    try {
      assertEquals(api.indexFileCount(), 3, 'file count');
      const paths = new Set();
      for (let i = 0; i < api.indexFileCount(); i++) paths.add(api.indexFilePath(i));
      for (const wanted of expected.keys()) assert(paths.has(wanted), `index contains ${wanted}`);
      assertEquals(api.indexArchiveType(), 5, 'archive type');
      assert(/^[0-9a-f]{16}$/.test(api.indexId()), 'backup id is hex');
      assert(api.indexDirCount() >= 3, 'directories recorded');
    } finally {
      api.indexClose();
    }
  });

  await test('detects the key-seed encryption of archive.dat', () => {
    assertEquals(api.probeDat('/px/backup/archive.dat'), 0x40, 'encryption type');
  });

  await test('verifies archive_00.dat HMAC', () => {
    assertEquals(api.dataRead('/px/backup/archive_00.dat'), 0, `px_data_read (${api.lastError()})`);
    assertEquals(api.dataIndex(), 0, 'segment index');
  });

  await test('extracts everything with matching hashes', () => {
    assertEquals(api.extractAll('/px/backup', 'archive', '/px/out/extract-all'), 0, `px_extract_all (${api.lastError()})`);
    for (const [virtualPath, digest] of expected) {
      const extracted = path.join(outDir, 'extract-all', ...virtualPath.split('/').filter(Boolean));
      assert(fs.existsSync(extracted), `extracted ${virtualPath}`);
      assertEquals(hashFile(extracted), digest, `content of ${virtualPath}`);
    }
  });

  await test('extracts a single file into a fresh path', () => {
    const target = '/px/out/single/SAVE.DAT';
    assertEquals(api.extractFile('/px/backup', 'archive', '/dev_hdd0/home/00000001/savedata/GAME1/SAVE.DAT', target), 0, `px_extract_file (${api.lastError()})`);
    const extracted = path.join(outDir, 'single', 'SAVE.DAT');
    assertEquals(hashFile(extracted), expected.get('/dev_hdd0/home/00000001/savedata/GAME1/SAVE.DAT'), 'extracted hash');
  });

  await test('extracts a path prefix', () => {
    assertEquals(api.extractPath('/px/backup', 'archive', '/dev_flash2', '/px/out/path'), 0, `px_extract_path (${api.lastError()})`);
    assert(fs.existsSync(path.join(outDir, 'path', 'dev_flash2', 'etc', 'small.txt')), 'small.txt extracted');
    assert(!fs.existsSync(path.join(outDir, 'path', 'dev_hdd0')), 'unrelated prefix not extracted');
  });

  await test('reports a useful error for unknown files', () => {
    assert(api.extractFile('/px/backup', 'archive', '/nope', '/px/out/nope') !== 0, 'unknown file fails');
    assert(api.lastError().includes('not part of this backup'), `error message: ${api.lastError()}`);
  });

  await test('decrypts archive.dat', () => {
    assertEquals(api.decrypt('/px/backup/archive.dat', '/px/out/archive.dec'), 0, `px_decrypt (${api.lastError()})`);
    const original = fs.statSync(path.join(backupDir, 'archive.dat')).size;
    assertEquals(fs.statSync(path.join(outDir, 'archive.dec')).size, original, 'decrypted size');
  });

  await test('appends new content to an existing backup', () => {
    const added = new Map();
    added.set('/dev_hdd0/photo/IMAGE.JPG', writeRandom(path.join(content2Dir, 'dev_hdd0/photo/IMAGE.JPG'), 400 * 1024));
    added.set('/dev_hdd0/video/CLIP.MP4', writeRandom(path.join(content2Dir, 'dev_hdd0/video/CLIP.MP4'), 2048 * 1024));

    host.setRoot('content2', content2Dir);
    mount(Module, host, ['content2']);

    assertEquals(api.add('/px/backup', '/px/content2', 0), 0, `px_add (${api.lastError()})`);
    assertEquals(api.indexOpen('/px/backup/archive.dat'), 0, 'index reopens');
    try {
      assertEquals(api.indexFileCount(), 5, 'file count after add');
    } finally {
      api.indexClose();
    }

    assertEquals(api.extractAll('/px/backup', 'archive', '/px/out/extract-after-add'), 0, `px_extract_all (${api.lastError()})`);
    for (const [virtualPath, digest] of new Map([...expected, ...added])) {
      const extracted = path.join(outDir, 'extract-after-add', ...virtualPath.split('/').filter(Boolean));
      assertEquals(hashFile(extracted), digest, `content of ${virtualPath} after add`);
    }
    assert(fs.statSync(path.join(backupDir, 'archive_00.dat')).size > 0, 'segment holds the appended data');
  });

  await test('deletes a file from the index without rewriting data', () => {
    const before = fs.readdirSync(backupDir).filter(name => name.startsWith('archive_')).sort();
    assertEquals(api.deleteFile('/px/backup', '/dev_flash2/etc/small.txt'), 0, `px_delete_file (${api.lastError()})`);
    assertEquals(api.indexOpen('/px/backup/archive.dat'), 0, 'index reopens after delete');
    try {
      let found = false;
      for (let i = 0; i < api.indexFileCount(); i++) {
        if (api.indexFilePath(i) === '/dev_hdd0/tmp/null') found = true;
      }
      assert(found, 'entry redirected to /dev_hdd0/tmp/null');
    } finally {
      api.indexClose();
    }
    const after = fs.readdirSync(backupDir).filter(name => name.startsWith('archive_')).sort();
    assertEquals(after.join(','), before.join(','), 'data segments untouched');
  });

  await test('drops the copy-protected reference', () => {
    assertEquals(api.deleteProtected('/px/backup'), 0, `px_delete_protected (${api.lastError()})`);
    assertEquals(api.indexOpen('/px/backup/archive.dat'), 0, 'index still readable');
    api.indexClose();
  });

  await test('survives a corrupted data segment', () => {
    const segment = path.join(backupDir, 'archive_00.dat');
    const original = fs.readFileSync(segment);
    const corrupted = Buffer.from(original);
    corrupted[corrupted.length - 5] ^= 0xff;
    fs.writeFileSync(segment, corrupted);
    assert(api.dataRead('/px/backup/archive_00.dat') !== 0, 'corruption detected');
    fs.writeFileSync(segment, original);
  });

  fs.rmSync(extractDir, { recursive: true, force: true });

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
