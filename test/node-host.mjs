// Synchronous host implementation backed by Node's fs module.
//
// Used by the test-suite so the exact same WebAssembly core and PXFS driver can
// be exercised without a browser. It implements the same interface as the
// browser host (web/host-directory.js).

import fs from 'node:fs';
import path from 'node:path';

export class NodeHost {
  constructor(roots = {}) {
    this.roots = new Map(Object.entries(roots));
    this.files = new Map();
    this.nextFd = 1;
  }

  setRoot(name, directory) {
    fs.mkdirSync(directory, { recursive: true });
    this.roots.set(name, directory);
  }

  full(root, rel) {
    const base = this.roots.get(root);
    if (!base) throw new Error(`root "${root}" is not mounted`);
    return rel === '' ? base : path.join(base, ...rel.split('/'));
  }

  stat(root, rel) {
    try {
      const stats = fs.statSync(this.full(root, rel));
      return { isDir: stats.isDirectory(), size: stats.size, mtimeMs: stats.mtimeMs };
    } catch {
      return null;
    }
  }

  readdir(root, rel) {
    const entries = [];
    for (const entry of fs.readdirSync(this.full(root, rel), { withFileTypes: true })) {
      if (entry.isDirectory()) {
        entries.push({ name: entry.name, isDir: true, size: 0, mtimeMs: 0 });
      } else {
        const stats = fs.statSync(this.full(root, rel === '' ? entry.name : `${rel}/${entry.name}`));
        entries.push({ name: entry.name, isDir: false, size: stats.size, mtimeMs: stats.mtimeMs });
      }
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return entries;
  }

  mkdir(root, rel) {
    fs.mkdirSync(this.full(root, rel), { recursive: true });
  }

  createFile(root, rel) {
    const target = this.full(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.closeSync(fs.openSync(target, 'a'));
  }

  truncate(root, rel, size) {
    fs.truncateSync(this.full(root, rel), size);
  }

  remove(root, rel) {
    fs.rmSync(this.full(root, rel), { recursive: true, force: true });
  }

  rename(rootFrom, relFrom, rootTo, relTo) {
    fs.renameSync(this.full(rootFrom, relFrom), this.full(rootTo, relTo));
  }

  open(root, rel, forWrite) {
    const fd = this.nextFd++;
    const target = this.full(root, rel);
    if (forWrite) fs.mkdirSync(path.dirname(target), { recursive: true });
    this.files.set(fd, fs.openSync(target, forWrite ? 'w+' : 'r'));
    return fd;
  }

  read(fd, position, length, target) {
    const handle = this.files.get(fd);
    return fs.readSync(handle, target, 0, length, position);
  }

  write(fd, position, data) {
    fs.writeSync(this.files.get(fd), data, 0, data.length, position);
  }

  close(fd) {
    const handle = this.files.get(fd);
    if (handle !== undefined) {
      fs.closeSync(handle);
      this.files.delete(fd);
    }
  }

  fdSize(fd) {
    return fs.fstatSync(this.files.get(fd)).size;
  }

  flushAll() {}

  // Bridge-compatible dispatcher (same shape as DirectoryHost.dispatch).
  async dispatch(op, args, data) {
    switch (op) {
      case 'stat': {
        const info = this.stat(args.root, args.rel);
        return info
          ? { n0: 1 | (info.isDir ? 2 : 0), n1: info.size >>> 0, n2: Math.floor(info.size / 0x100000000) }
          : { n0: 0 };
      }      case 'readdir': {
        const text = new TextEncoder().encode(JSON.stringify(this.readdir(args.root, args.rel)));
        data.set(text, 0);
        return { n0: text.length };
      }
      case 'mkdir': this.mkdir(args.root, args.rel); return {};
      case 'createFile': this.createFile(args.root, args.rel); return {};
      case 'truncate': this.truncate(args.root, args.rel, args.size); return {};
      case 'remove': this.remove(args.root, args.rel); return {};
      case 'rename': this.rename(args.rootFrom, args.relFrom, args.rootTo, args.relTo); return {};
      case 'open': return { n0: this.open(args.root, args.rel, args.forWrite), n1: 0 };
      case 'read': {
        const buffer = data.subarray(0, args.length);
        const read = this.read(args.fd, args.position, args.length, buffer);
        return { n0: read };
      }
      case 'write': {
        this.write(args.fd, args.position, data.subarray(0, args.length));
        return { n0: args.length };
      }
      case 'close': this.close(args.fd); return {};
      case 'size': {
        const size = this.fdSize(args.fd);
        return { n0: size >>> 0, n1: Math.floor(size / 0x100000000) };
      }
      default: throw new Error(`unknown fs op ${op}`);
    }
  }
}
