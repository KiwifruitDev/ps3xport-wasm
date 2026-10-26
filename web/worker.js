// Web worker that hosts the WebAssembly core. The main thread owns the real
// file handles; this worker only talks to them through the synchronous
// SharedArrayBuffer bridge, so the blocking C code can run unmodified.

import createModule from './ps3xport.mjs';
import { installPxfs } from './pxfs.js';
import { createRemoteHost } from './host-remote.js';
import { createBridgeClient, DATA_BYTES } from './sync-bridge.js';

let Module = null;
let api = null;
let mounted = new Set();

function bind() {
  const wrap = (name, ret, args) => Module.cwrap(name, ret, args);
  return {
    init: wrap('px_init', 'number', []),
    lastError: wrap('px_last_error', 'string', []),
    setDeviceId: wrap('px_set_device_id', 'number', ['string']),
    setOpenPsid: wrap('px_set_open_psid', 'number', ['string']),
    indexOpen: wrap('px_index_open', 'number', ['string']),
    indexClose: wrap('px_index_close', null, []),
    indexFileCount: wrap('px_index_file_count', 'number', []),
    indexFilePath: wrap('px_index_file_path', 'string', ['number']),
    indexFileSize: wrap('px_index_file_size', 'number', ['number']),
    indexFileMode: wrap('px_index_file_mode', 'number', ['number']),
    indexFileMtime: wrap('px_index_file_mtime', 'number', ['number']),
    indexFileFlags: wrap('px_index_file_flags', 'number', ['number']),
    indexDirCount: wrap('px_index_dir_count', 'number', []),
    indexDirPath: wrap('px_index_dir_path', 'string', ['number']),
    indexDirMode: wrap('px_index_dir_mode', 'number', ['number']),
    indexDirMtime: wrap('px_index_dir_mtime', 'number', ['number']),
    indexDirFlags: wrap('px_index_dir_flags', 'number', ['number']),
    indexTotalFiles: wrap('px_index_total_files', 'number', []),
    indexTotalFileSizes: wrap('px_index_total_file_sizes', 'number', []),
    indexTotalDirs: wrap('px_index_total_dirs', 'number', []),
    indexArchive2Size: wrap('px_index_archive2_size', 'number', []),
    indexArchiveType: wrap('px_index_archive_type', 'number', []),
    indexId: wrap('px_index_id', 'string', []),
    indexPsid: wrap('px_index_psid', 'string', []),
    probeDat: wrap('px_probe_dat', 'number', ['string']),
    dataRead: wrap('px_data_read', 'number', ['string']),
    dataId: wrap('px_data_id', 'string', []),
    dataIndex: wrap('px_data_index', 'number', []),
    dataArchiveType: wrap('px_data_archive_type', 'number', []),
    dataFileType: wrap('px_data_file_type', 'number', []),
    extractFile: wrap('px_extract_file', 'number', ['string', 'string', 'string', 'string']),
    extractAll: wrap('px_extract_all', 'number', ['string', 'string', 'string']),
    extractPath: wrap('px_extract_path', 'number', ['string', 'string', 'string', 'string']),
    decrypt: wrap('px_decrypt', 'number', ['string', 'string']),
    createBackup: wrap('px_create_backup', 'number', ['string', 'string', 'string']),
    add: wrap('px_add', 'number', ['string', 'string', 'number']),
    deleteFile: wrap('px_delete_file', 'number', ['string', 'string']),
    deletePath: wrap('px_delete_path', 'number', ['string', 'string']),
    deleteProtected: wrap('px_delete_protected', 'number', ['string']),
    indexNew: wrap('px_index_new', 'number', ['number']),
    indexHasFile: wrap('px_index_has_file', 'number', ['string']),
    indexRemoveFile: wrap('px_index_remove_file', 'number', ['string']),
    indexRenameFile: wrap('px_index_rename_file', 'number', ['string', 'string']),
    indexUpdateFile: wrap('px_index_update_file', 'number', ['string', 'number', 'number', 'number', 'number']),
    indexAddFile: wrap('px_index_add_file', 'number', ['string', 'number', 'number', 'number', 'number']),
    indexClearDirs: wrap('px_index_clear_dirs', 'number', []),
    indexAddDir: wrap('px_index_add_dir', 'number', ['string', 'number', 'number', 'number']),
    indexSetArchive2Size: wrap('px_index_set_archive2_size', 'number', ['number']),
    indexSave: wrap('px_index_save', 'number', ['string']),
    chunkBegin: wrap('px_chunk_begin', 'number', ['string', 'string', 'number', 'number', 'number']),
    chunkWrite: wrap('px_chunk_write', 'number', ['number', 'number']),
    chunkCopy: wrap('px_chunk_copy', 'number', ['string', 'number', 'number']),
    chunkFinish: wrap('px_chunk_finish', 'number', []),
    chunkAbort: wrap('px_chunk_abort', 'number', []),
    chunkSize: wrap('px_chunk_size', 'number', []),
  };
}

let copyBuffer = 0;
let copyBufferSize = 0;

function chunkWrite({ data }) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length > copyBufferSize) {
    if (copyBuffer) Module._free(copyBuffer);
    copyBuffer = Module._malloc(bytes.length);
    copyBufferSize = bytes.length;
  }
  Module.HEAPU8.set(bytes, copyBuffer);
  check(api.chunkWrite(copyBuffer, bytes.length));
  return { n: bytes.length };
}

function check(code) {
  if (code !== 0) throw new Error(api.lastError() || `core call failed (${code})`);
}

function mount(name) {
  const FS = Module.FS;
  if (!FS.analyzePath('/px').exists) FS.mkdir('/px');
  const mountpoint = `/px/${name}`;
  if (mounted.has(name)) {
    // Re-mounting a different directory under the same name must drop the old
    // node tree, otherwise cached nodes point at the previous folder.
    try {
      FS.unmount(mountpoint);
    } catch {
      // not mounted yet
    }
    mounted.delete(name);
  }
  if (!FS.analyzePath(mountpoint).exists) FS.mkdir(mountpoint);
  FS.mount(Module.PXFS, { root: name }, mountpoint);
  mounted.add(name);
}

const commands = {
  listIndex({ path }) {
    let opened = false;
    try {
      check(api.indexOpen(path));
      opened = true;
      const files = [];
      const fileCount = api.indexFileCount();
      for (let i = 0; i < fileCount; i++) {
        files.push({
          path: api.indexFilePath(i),
          size: api.indexFileSize(i),
          mode: api.indexFileMode(i),
          mtime: api.indexFileMtime(i),
          flags: api.indexFileFlags(i),
        });
      }
      const dirs = [];
      const dirCount = api.indexDirCount();
      for (let i = 0; i < dirCount; i++) {
        dirs.push({
          path: api.indexDirPath(i),
          mode: api.indexDirMode(i),
          mtime: api.indexDirMtime(i),
          flags: api.indexDirFlags(i),
        });
      }
      return {
        archiveType: api.indexArchiveType(),
        id: api.indexId(),
        psid: api.indexPsid(),
        totalFiles: api.indexTotalFiles(),
        totalFileSizes: api.indexTotalFileSizes(),
        totalDirs: api.indexTotalDirs(),
        archive2Size: api.indexArchive2Size(),
        files,
        dirs,
      };
    } finally {
      if (opened) api.indexClose();
    }
  },

  probe({ path }) {
    return { encryptionType: api.probeDat(path) };
  },

  verifyData({ path }) {
    check(api.dataRead(path));
    return {
      id: api.dataId(),
      index: api.dataIndex(),
      archiveType: api.dataArchiveType(),
      fileType: api.dataFileType(),
    };
  },

  extractFile({ dir, prefix, filename, out }) {
    check(api.extractFile(dir, prefix, filename, out));
    return {};
  },

  extractAll({ dir, prefix, outdir }) {
    check(api.extractAll(dir, prefix, outdir));
    return {};
  },

  extractPath({ dir, prefix, match, outdir }) {
    check(api.extractPath(dir, prefix, match, outdir));
    return {};
  },

  decrypt({ input, output }) {
    check(api.decrypt(input, output));
    return {};
  },

  createBackup({ dir, content, protectedContent }) {
    check(api.createBackup(dir, content, protectedContent));
    return {};
  },

  add({ dir, content, protectedContent }) {
    check(api.add(dir, content, protectedContent ? 1 : 0));
    return {};
  },

  deleteFile({ dir, filename }) {
    check(api.deleteFile(dir, filename));
    return {};
  },

  deletePath({ dir, match }) {
    check(api.deletePath(dir, match));
    return {};
  },

  deleteProtected({ dir }) {
    check(api.deleteProtected(dir));
    return {};
  },

  setDeviceId({ hex }) {
    check(api.setDeviceId(hex));
    return {};
  },

  setOpenPsid({ hex }) {
    check(api.setOpenPsid(hex));
    return {};
  },

  indexBegin({ open, create }) {
    if (create !== null && create !== undefined) check(api.indexNew(create));
    else check(api.indexOpen(open));
    return {
      id: api.indexId(),
      archiveType: api.indexArchiveType(),
      files: api.indexFileCount(),
      dirs: api.indexDirCount(),
    };
  },

  indexApply({ remove = [], rename = [], update = [], add = [], dirs = null, archive2Size = null, saveTo }) {
    for (const path of remove) check(api.indexRemoveFile(path));
    for (const item of rename) check(api.indexRenameFile(item.from, item.to));
    for (const item of update) {
      check(api.indexUpdateFile(item.path, item.size, item.mode ?? 0, item.mtime ?? 0, item.flags ?? 0));
    }
    for (const item of add) {
      check(api.indexAddFile(item.path, item.size, item.mode ?? 0, item.mtime ?? 0, item.flags ?? 0));
    }
    if (dirs) {
      check(api.indexClearDirs());
      for (const dir of dirs) {
        check(api.indexAddDir(dir.path, dir.mode ?? 0, dir.mtime ?? 0, dir.flags ?? 0));
      }
    }
    if (archive2Size !== null && archive2Size !== undefined) api.indexSetArchive2Size(archive2Size);
    check(api.indexSave(saveTo));
    return {};
  },

  indexClose() {
    api.indexClose();
    return {};
  },

  chunkBegin({ path, id, index, archiveType, cap }) {
    check(api.chunkBegin(path, id, index, archiveType, cap));
    return {};
  },

  chunkWrite,

  chunkCopy({ source, offset, length }) {
    check(api.chunkCopy(source, offset, length));
    return {};
  },

  chunkFinish() {
    const size = api.chunkSize();
    check(api.chunkFinish());
    return { size };
  },

  chunkAbort() {
    api.chunkAbort();
    return {};
  },
};

async function setup(sab) {
  const client = createBridgeClient(sab, DATA_BYTES);
  Module = await createModule({
    locateFile: file => new URL(file, import.meta.url).href,
  });
  installPxfs(Module, createRemoteHost(client));
  api = bind();
  check(api.init());
  postMessage({ type: 'ready' });
}

self.onmessage = async event => {
  const message = event.data;
  if (!message || typeof message !== 'object') return;

  if (message.type === 'init') {
    try {
      await setup(message.sab);
    } catch (error) {
      postMessage({ type: 'fatal', error: String(error?.message ?? error) });
    }
    return;
  }

  if (message.type === 'mount') {
    try {
      mount(message.name);
      postMessage({ type: 'mount-result', id: message.id, ok: true });
    } catch (error) {
      postMessage({ type: 'mount-result', id: message.id, ok: false, error: String(error?.message ?? error) });
    }
    return;
  }

  if (message.type !== 'rpc') return;

  const handler = commands[message.cmd];
  if (!handler) {
    postMessage({ type: 'rpc-result', id: message.id, ok: false, error: `unknown command ${message.cmd}` });
    return;
  }

  try {
    const result = await handler(message.args ?? {});
    postMessage({ type: 'rpc-result', id: message.id, ok: true, result });
  } catch (error) {
    postMessage({ type: 'rpc-result', id: message.id, ok: false, error: String(error?.message ?? error) });
  }
};
