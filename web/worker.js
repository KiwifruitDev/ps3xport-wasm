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
    indexDirCount: wrap('px_index_dir_count', 'number', []),
    indexDirPath: wrap('px_index_dir_path', 'string', ['number']),
    indexDirMode: wrap('px_index_dir_mode', 'number', ['number']),
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
  };
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
        });
      }
      const dirs = [];
      const dirCount = api.indexDirCount();
      for (let i = 0; i < dirCount; i++) {
        dirs.push({ path: api.indexDirPath(i), mode: api.indexDirMode(i) });
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
