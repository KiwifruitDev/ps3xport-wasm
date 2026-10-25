// In-memory filesystem tree used as the panel's working copy.
//
// The tree only holds metadata eagerly. File contents are represented by a
// "content source" and are materialised on demand:
//
//   { kind: 'blob', blob }                  already in memory (edited/imported)
//   { kind: 'archive', prefix, srcPath }    still inside the backup on disk
//   { kind: 'handle', dir, rel }            a file in a folder the user picked
//   { kind: 'zip', entry, srcPath }         an entry of an imported zip
//   null                                    an empty, newly created file
//
// Keeping it this way means opening a 20 GiB backup costs a few megabytes of
// metadata instead of the whole content, and edits only ever hold the files
// the user actually touched.

export function normalizePath(path) {
  const segments = String(path ?? '').split('/').filter(Boolean);
  const stack = [];
  for (const segment of segments) {
    if (segment === '.') continue;
    if (segment === '..') stack.pop();
    else stack.push(segment);
  }
  return `/${stack.join('/')}`;
}

export function dirName(path) {
  const normalized = normalizePath(path);
  if (normalized === '/') return '/';
  const index = normalized.lastIndexOf('/');
  return index <= 0 ? '/' : normalized.slice(0, index);
}

export function baseName(path) {
  const normalized = normalizePath(path);
  return normalized === '/' ? '' : normalized.slice(normalized.lastIndexOf('/') + 1);
}

export function joinPath(base, name) {
  return normalizePath(`${base}/${name}`);
}

function notFound(path) {
  const error = new Error(`No such file or directory: ${path}`);
  error.name = 'NotFoundError';
  return error;
}

function notDir(path) {
  const error = new Error(`Not a directory: ${path}`);
  error.name = 'TypeMismatchError';
  return error;
}

function makeDir(mtime = Date.now()) {
  return { type: 'dir', children: new Map(), mtime: new Date(mtime) };
}

function makeFile({ size = 0, content = null, mtime = Date.now(), mode = 0o644 } = {}) {
  const stamp = mtime instanceof Date ? mtime : new Date(mtime);
  return { type: 'file', size, content, mtime: stamp, mode };
}

export class Vfs {
  constructor() {
    this.root = makeDir();
  }

  get(path) {
    const normalized = normalizePath(path);
    if (normalized === '/') return this.root;
    let node = this.root;
    for (const segment of normalized.slice(1).split('/')) {
      if (node.type !== 'dir') return null;
      node = node.children.get(segment);
      if (!node) return null;
    }
    return node;
  }

  has(path) {
    return Boolean(this.get(path));
  }

  ensureDir(path) {
    const normalized = normalizePath(path);
    if (normalized === '/') return this.root;
    let node = this.root;
    for (const segment of normalized.slice(1).split('/')) {
      let child = node.children.get(segment);
      if (!child) {
        child = makeDir();
        node.children.set(segment, child);
      } else if (child.type !== 'dir') {
        throw notDir(normalized);
      }
      node = child;
    }
    return node;
  }

  mkdir(path) {
    const parent = this.ensureDir(dirName(path));
    const name = baseName(path);
    if (!name) return parent;
    const existing = parent.children.get(name);
    if (existing) {
      if (existing.type !== 'dir') throw new Error(`${path} already exists and is a file`);
      return existing;
    }
    const node = makeDir();
    parent.children.set(name, node);
    return node;
  }

  /** Creates or replaces a file node. */
  put(path, options = {}) {
    const normalized = normalizePath(path);
    const parent = this.ensureDir(dirName(normalized));
    const node = makeFile(options);
    parent.children.set(baseName(normalized), node);
    return node;
  }

  putBlob(path, blob, extra = {}) {
    return this.put(path, { ...extra, size: blob.size, content: { kind: 'blob', blob } });
  }

  remove(path) {
    const normalized = normalizePath(path);
    if (normalized === '/') throw new Error('Cannot remove the root folder.');
    const parent = this.get(dirName(normalized));
    if (!parent || parent.type !== 'dir') return false;
    return parent.children.delete(baseName(normalized));
  }

  rename(path, newName) {
    const normalized = normalizePath(path);
    const parent = this.get(dirName(normalized));
    if (!parent || parent.type !== 'dir' || !parent.children.has(baseName(normalized))) {
      throw notFound(normalized);
    }
    const target = normalizePath(newName);
    // Accept either a bare name or an absolute destination path.
    const destination = target.includes('/') ? target : joinPath(dirName(normalized), target);
    if (destination === normalized) return;
    if (this.get(destination)) throw new Error(`"${baseName(destination)}" already exists`);
    const destinationParent = this.ensureDir(dirName(destination));
    const node = parent.children.get(baseName(normalized));
    parent.children.delete(baseName(normalized));
    destinationParent.children.set(baseName(destination), node);
  }

  list(path) {
    const node = this.get(path);
    if (!node) throw notFound(path);
    if (node.type !== 'dir') throw notDir(path);
    const entries = [];
    for (const [name, child] of node.children) {
      entries.push({
        name,
        path: joinPath(path, name),
        type: child.type,
        size: child.type === 'file' ? child.size : 0,
        mtime: child.mtime,
        mode: child.mode ?? (child.type === 'dir' ? 0o755 : 0o644),
        node: child,
      });
    }
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });
    return entries;
  }

  /** Depth-first walk of every file, with its absolute path. */
  *files(path = '/') {
    const node = this.get(path);
    if (!node || node.type !== 'dir') return;
    for (const [name, child] of node.children) {
      const childPath = joinPath(path, name);
      if (child.type === 'dir') yield* this.files(childPath);
      else yield { path: childPath, node: child };
    }
  }

  /** Depth-first walk of every directory (including the root). */
  *dirs(path = '/') {
    const node = this.get(path);
    if (!node || node.type !== 'dir') return;
    yield { path, node };
    for (const [name, child] of node.children) {
      if (child.type === 'dir') yield* this.dirs(joinPath(path, name));
    }
  }

  stats(path = '/') {
    let files = 0;
    let dirs = 0;
    let bytes = 0;
    for (const entry of this.files(path)) {
      files++;
      bytes += entry.node.size;
    }
    for (const _ of this.dirs(path)) dirs++;
    return { files, dirs, bytes };
  }

  clear() {
    this.root = makeDir();
  }

  /**
   * Removes a file node and returns its blob when it lives in memory. Used to
   * hand content over to callers without keeping a second reference alive.
   */
  takeBlob(path) {
    const node = this.get(path);
    if (!node || node.type !== 'file' || node.content?.kind !== 'blob') return null;
    this.remove(path);
    return node.content.blob;
  }
}

const WRITABLE_BUFFER_LIMIT = 512 * 1024 * 1024;

class Writable {
  constructor() {
    this.parts = [];
    this.size = 0;
    this.buffer = null;
  }

  materialize() {
    if (this.buffer) return this.buffer;
    if (this.parts.length) {
      // Copying Blob parts back requires asynchronous reads, which a blocking
      // filesystem call cannot perform. Only sequential writers are supported.
      throw new Error('random-access writes into an in-memory file are not supported');
    }
    this.buffer = new Uint8Array(0);
    return this.buffer;
  }

  ensure(size) {
    const buffer = this.materialize();
    if (size <= buffer.length) return buffer;
    const grown = new Uint8Array(Math.max(size, Math.ceil(buffer.length * 1.5), 4096));
    grown.set(buffer);
    this.buffer = grown;
    return grown;
  }

  write(position, chunk) {
    if (this.buffer || position !== this.size) {
      const buffer = this.ensure(position + chunk.length);
      buffer.set(chunk, position);
      this.size = Math.max(this.size, position + chunk.length);
      return;
    }
    if (this.size + chunk.length > WRITABLE_BUFFER_LIMIT) {
      throw new Error('file is too large to rebuild in memory');
    }
    this.parts.push(new Blob([chunk.slice()]));
    this.size += chunk.length;
  }

  truncate(size) {
    if (size === 0) {
      this.parts = [];
      this.buffer = new Uint8Array(0);
      this.size = 0;
      return;
    }
    const buffer = this.ensure(size);
    if (size < this.size) buffer.fill(0, size, this.size);
    this.size = size;
  }

  toBlob() {
    if (this.buffer) return new Blob([this.buffer.subarray(0, this.size)]);
    return new Blob(this.parts);
  }
}

/**
 * Adapts a Vfs to the same host interface as DirectoryHost, so the WebAssembly
 * core can mount it as a normal directory (used for zip imports and for
 * scratch space when extracting single files).
 */
export class MemoryHost {
  constructor(vfs, { onProgress } = {}) {
    this.vfs = vfs;
    this.open = new Map();
    this.nextFd = 1;
    this.onProgress = onProgress;
  }

  report(bytes) {
    this.onProgress?.(bytes);
  }

  async dispatch(op, args, data) {
    try {
      return await this.run(op, args, data);
    } catch (error) {
      const detail = error?.message ?? String(error);
      const target = args.rel ?? args.path ?? '';
      const wrapped = new Error(`${op} ${target}: ${detail}`.trim());
      wrapped.name = error?.name ?? 'Error';
      throw wrapped;
    }
  }

  async run(op, args, data) {
    switch (op) {
      case 'stat': {
        const node = args.rel === '' ? this.vfs.root : this.vfs.get(args.rel);
        if (!node) return { n0: 0 };
        return { n0: 1, n1: node.type === 'file' ? node.size : 0, n2: node.type === 'dir' ? 1 : 0 };
      }
      case 'readdir': {
        const node = this.vfs.get(args.rel);
        if (!node) throw notFound(args.rel);
        if (node.type !== 'dir') throw notDir(args.rel);
        const entries = this.vfs.list(args.rel).map(entry => ({
          name: entry.name,
          isDir: entry.type === 'dir',
          size: entry.size,
        }));
        const text = new TextEncoder().encode(JSON.stringify(entries));
        if (text.length > data.length) throw new Error('directory listing is too large');
        data.set(text, 0);
        return { n0: text.length };
      }
      case 'mkdir':
        this.vfs.mkdir(args.rel);
        return {};
      case 'createFile': {
        const parent = this.vfs.ensureDir(dirName(args.rel));
        const name = baseName(args.rel);
        if (!parent.children.has(name)) parent.children.set(name, makeFile({ content: null }));
        return {};
      }
      case 'truncate': {
        const node = this.vfs.get(args.rel);
        if (!node) {
          this.vfs.put(args.rel, { content: { kind: 'blob', blob: new Blob([]) }, size: 0 });
        } else if (node.type !== 'file') {
          throw notDir(args.rel);
        } else if (args.size === 0) {
          node.size = 0;
          node.content = { kind: 'blob', blob: new Blob([]) };
        } else if (node.size !== args.size) {
          const blob = node.content?.kind === 'blob' ? node.content.blob : new Blob([]);
          const next = args.size > blob.size
            ? new Blob([blob, new Uint8Array(args.size - blob.size)])
            : blob.slice(0, args.size);
          node.size = args.size;
          node.content = { kind: 'blob', blob: next };
        }
        return {};
      }
      case 'remove':
        this.vfs.remove(args.rel);
        return {};
      case 'rename': {
        const node = this.vfs.get(args.relFrom);
        if (!node) throw notFound(args.relFrom);
        this.vfs.remove(args.relFrom);
        this.vfs.remove(args.relTo);
        if (args.relTo !== '') {
          const parent = this.vfs.ensureDir(dirName(args.relTo));
          parent.children.set(baseName(args.relTo), node);
        }
        return {};
      }
      case 'open': {
        const fd = this.nextFd++;
        if (args.forWrite) {
          const parent = this.vfs.ensureDir(dirName(args.rel));
          const name = baseName(args.rel);
          const node = makeFile({ content: { kind: 'blob', blob: new Blob([]) }, size: 0 });
          parent.children.set(name, node);
          this.open.set(fd, { kind: 'write', path: args.rel, writable: new Writable(), node, position: 0 });
        } else {
          const node = this.vfs.get(args.rel);
          if (!node) throw notFound(args.rel);
          if (node.type !== 'file') throw notDir(args.rel);
          this.open.set(fd, { kind: 'read', node, size: node.size, position: 0 });
        }
        return { n0: fd, n1: 0 };
      }
      case 'read': {
        const entry = this.open.get(args.fd);
        if (!entry || entry.kind !== 'read') throw new Error('bad file descriptor');
        if (args.length === 0) return { n0: 0 };
        const chunk = await readNode(entry.node, args.position, args.length);
        if (!chunk.length) return { n0: 0 };
        data.set(chunk, 0);
        this.report(chunk.length);
        return { n0: chunk.length };
      }
      case 'write': {
        const entry = this.open.get(args.fd);
        if (!entry || entry.kind !== 'write') throw new Error('bad file descriptor');
        const slice = data.subarray(0, args.length);
        entry.writable.write(args.position, slice);
        this.report(slice.length);
        return { n0: args.length };
      }
      case 'close': {
        const entry = this.open.get(args.fd);
        if (!entry) return {};
        this.open.delete(args.fd);
        if (entry.kind === 'write') {
          const blob = entry.writable.toBlob();
          entry.node.content = { kind: 'blob', blob };
          entry.node.size = blob.size;
          entry.node.mtime = new Date();
        }
        return {};
      }
      case 'size': {
        const entry = this.open.get(args.fd);
        if (!entry) return { n0: 0 };
        return { n0: entry.kind === 'write' ? entry.writable.size : entry.size };
      }
      default:
        throw new Error(`unknown filesystem operation "${op}"`);
    }
  }
}

/** Reads a byte range out of a node, whatever its content source is. */
async function readNode(node, position, length) {
  if (position >= node.size || length <= 0) return new Uint8Array(0);
  const end = Math.min(position + length, node.size);
  const content = node.content;
  if (!content) return new Uint8Array(0);
  if (content.kind === 'blob') {
    return new Uint8Array(await content.blob.slice(position, end).arrayBuffer());
  }
  if (content.kind === 'handle') {
    const handle = await resolveHandleFile(content.dir, content.rel);
    const blob = await handle.getFile();
    return new Uint8Array(await blob.slice(position, end).arrayBuffer());
  }
  if (content.kind === 'zip') {
    const blob = await content.entry.getBlob();
    return new Uint8Array(await blob.slice(position, end).arrayBuffer());
  }
  throw new Error('this file needs to be materialised before it can be read');
}

async function resolveHandleFile(dir, rel) {
  const segments = String(rel).split('/').filter(Boolean);
  const name = segments.pop();
  let current = dir;
  for (const segment of segments) current = await current.getDirectoryHandle(segment);
  return await current.getFileHandle(name);
}
