// Main-thread host for the PXFS driver, backed by File System Access API
// directory handles picked by the user.
//
// Every method is async here; the worker wrapper forwards to them through the
// SharedArrayBuffer bridge.

const COPY_CHUNK = 4 * 1024 * 1024;

function splitRel(rel) {
  return rel === '' ? [] : rel.split('/');
}

export class DirectoryHost {
  constructor() {
    this.roots = new Map();
    this.files = new Map();
    this.open = new Map();
    this.nextFd = 1;
    this.bytesMoved = 0;
    this.onProgress = null;
    // Reported to the page so a progress dialog can show which archive chunk
    // is currently being read or written.
    this.activity = { reads: 0, writes: 0, readPath: '', writePath: '' };
  }

  report(delta) {
    this.bytesMoved += delta;
    this.onProgress?.(this.bytesMoved);
  }

  setRoot(name, handle) {
    this.roots.set(name, handle);
    this.invalidate(name);
  }

  /** Drops cached File objects for a root after it was written to directly. */
  invalidate(name) {
    for (const key of [...this.files.keys()]) {
      if (key.startsWith(`${name}\u0000`)) this.files.delete(key);
    }
  }

  clearRoot(name) {
    this.roots.delete(name);
  }

  hasRoot(name) {
    return this.roots.has(name);
  }

  async resolveDir(root, rel, create = false) {
    const handle = this.roots.get(root);
    if (!handle) throw new Error(`root "${root}" is not mounted`);
    let dir = handle;
    for (const name of splitRel(rel)) {
      dir = await dir.getDirectoryHandle(name, { create });
    }
    return dir;
  }

  async resolveParent(root, rel, create = false) {
    const segments = splitRel(rel);
    if (segments.length === 0) throw new Error('cannot operate on the mount root');
    const name = segments.pop();
    const dir = await this.resolveDir(root, segments.join('/'), create);
    return { dir, name };
  }

  async getHandle(root, rel) {
    const { dir, name } = await this.resolveParent(root, rel);
    try {
      return await dir.getFileHandle(name, { create: false });
    } catch (error) {
      if (error?.name === 'TypeMismatchError') return await dir.getDirectoryHandle(name, { create: false });
      throw error;
    }
  }

  async getFile(root, rel) {
    const key = `${root}\u0000${rel}`;
    const cached = this.files.get(key);
    if (cached) return cached;
    const handle = await this.getHandle(root, rel);
    const file = await handle.getFile();
    this.files.set(key, file);
    return file;
  }

  // n0 bit 0 = exists, bit 1 = directory. A 64-bit size does not fit in the
  // 32-bit bridge words, so it is split into an unsigned low and a high word.
  async stat(root, rel) {
    if (rel === '') return { n0: 3, n1: 0, n2: 0 };
    let dir;
    let name;
    try {
      ({ dir, name } = await this.resolveParent(root, rel));
    } catch (error) {
      if (error?.name === 'NotFoundError') return { n0: 0 };
      throw error;
    }
    try {
      const handle = await dir.getFileHandle(name, { create: false });
      const file = await handle.getFile();
      this.files.set(`${root}\u0000${rel}`, file);
      return { n0: 1, n1: file.size >>> 0, n2: Math.floor(file.size / 0x100000000) };
    } catch (error) {
      if (error?.name !== 'TypeMismatchError' && error?.name !== 'NotFoundError') throw error;
    }
    try {
      await dir.getDirectoryHandle(name, { create: false });
      return { n0: 3, n1: 0, n2: 0 };
    } catch (error) {
      if (error?.name === 'NotFoundError') return { n0: 0 };
      throw error;
    }
  }

  async readdir(root, rel, data) {
    const dir = await this.resolveDir(root, rel);
    const entries = [];
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'directory') {
        entries.push({ name, isDir: true, size: 0 });
      } else {
        const file = await handle.getFile();
        this.files.set(`${root}\u0000${rel === '' ? name : `${rel}/${name}`}`, file);
        entries.push({ name, isDir: false, size: file.size });
      }
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const text = new TextEncoder().encode(JSON.stringify(entries));
    if (text.length > data.length) throw new Error('directory listing is too large');
    data.set(text, 0);
    return { n0: text.length };
  }

  async mkdir(root, rel) {
    const { dir, name } = await this.resolveParent(root, rel, true);
    await dir.getDirectoryHandle(name, { create: true });
  }

  async createFile(root, rel) {
    const { dir, name } = await this.resolveParent(root, rel, true);
    await dir.getFileHandle(name, { create: true });
  }

  async truncate(root, rel, size) {
    const { dir, name } = await this.resolveParent(root, rel, true);
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable({ keepExistingData: true });
    await writable.truncate(size);
    await writable.close();
    this.files.delete(`${root}\u0000${rel}`);
  }

  async remove(root, rel) {
    const { dir, name } = await this.resolveParent(root, rel);
    await dir.removeEntry(name, { recursive: true });
    this.files.delete(`${root}\u0000${rel}`);
  }

  async copyRecursive(source, targetDir, targetName) {
    if (source.kind === 'file') {
      const file = await source.getFile();
      const writable = await (await targetDir.getFileHandle(targetName, { create: true })).createWritable();
      for (let offset = 0; offset < file.size; offset += COPY_CHUNK) {
        const blob = file.slice(offset, Math.min(offset + COPY_CHUNK, file.size));
        const buffer = await blob.arrayBuffer();
        await writable.write(buffer);
        this.report(buffer.byteLength);
      }
      await writable.close();
      return;
    }

    const dir = await targetDir.getDirectoryHandle(targetName, { create: true });
    for await (const [name, handle] of source.entries()) {
      await this.copyRecursive(handle, dir, name);
    }
  }

  async rename(rootFrom, relFrom, rootTo, relTo) {
    const source = await this.getHandle(rootFrom, relFrom);
    const { dir: targetDir, name: targetName } = await this.resolveParent(rootTo, relTo);

    if (typeof source.move === 'function') {
      try {
        await source.move(targetDir, targetName);
        this.files.delete(`${rootFrom}\u0000${relFrom}`);
        return;
      } catch {
        // Chrome only implements move() for real directories in some versions.
      }
    }

    await this.copyRecursive(source, targetDir, targetName);
    const { dir: sourceDir, name: sourceName } = await this.resolveParent(rootFrom, relFrom);
    await sourceDir.removeEntry(sourceName, { recursive: true });
    this.files.delete(`${rootFrom}\u0000${relFrom}`);
  }

  async openFile(root, rel, forWrite) {
    const fd = this.nextFd++;
    if (forWrite) {
      const { dir, name } = await this.resolveParent(root, rel, true);
      let exists = true;
      try {
        await dir.getFileHandle(name, { create: false });
      } catch {
        exists = false;
      }
      const handle = await dir.getFileHandle(name, { create: true });
      // keepExistingData lets the core rewrite the HMAC at offset 8 after it
      // has streamed the rest of the index file.
      const writable = exists
        ? await handle.createWritable({ keepExistingData: true })
        : await handle.createWritable();
      await writable.truncate(0);
      this.open.set(fd, { kind: 'write', rel, writable, position: 0, size: 0 });
      this.files.delete(`${root}\u0000${rel}`);
    } else {
      const file = await this.getFile(root, rel);
      this.open.set(fd, { kind: 'read', rel, file, size: file.size });
    }
    return { n0: fd, n1: 0 };
  }

  async readFile(fd, position, length, data) {
    const entry = this.open.get(fd);
    if (!entry || entry.kind !== 'read') throw new Error('bad file descriptor');
    if (position >= entry.size || length === 0) return { n0: 0 };
    const end = Math.min(position + length, entry.size);
    const buffer = await entry.file.slice(position, end).arrayBuffer();
    data.set(new Uint8Array(buffer), 0);
    this.report(buffer.byteLength);
    this.activity.reads += buffer.byteLength;
    this.activity.readPath = entry.rel ?? '';
    return { n0: buffer.byteLength };
  }

  async writeFile(fd, position, length, data) {
    const entry = this.open.get(fd);
    if (!entry || entry.kind !== 'write') throw new Error('bad file descriptor');
    const copy = new Uint8Array(length);
    copy.set(data.subarray(0, length));
    if (position === entry.size && entry.position === entry.size) {
      await entry.writable.write(copy);
    } else {
      await entry.writable.write({ type: 'write', position, data: copy });
    }
    entry.position = position + length;
    entry.size = Math.max(entry.size, position + length);
    this.report(length);
    this.activity.writes += length;
    this.activity.writePath = entry.rel ?? '';
    return { n0: length };
  }

  async closeFile(fd) {
    const entry = this.open.get(fd);
    if (!entry) return {};
    this.open.delete(fd);
    if (entry.kind === 'write') await entry.writable.close();
    return {};
  }

  fileSize(fd) {
    const entry = this.open.get(fd);
    const size = entry ? entry.size : 0;
    return { n0: size >>> 0, n1: Math.floor(size / 0x100000000) };
  }

  async dispatch(op, args, data) {
    try {
      return await this.run(op, args, data);
    } catch (error) {
      const detail = error?.message ?? String(error);
      const target = args.rel ?? args.path ?? args.root ?? '';
      throw new Error(`${op} ${target}: ${detail}`.trim());
    }
  }

  async run(op, args, data) {
    switch (op) {
      case 'stat': return await this.stat(args.root, args.rel);
      case 'readdir': return await this.readdir(args.root, args.rel, data);
      case 'mkdir': await this.mkdir(args.root, args.rel); return {};
      case 'createFile': await this.createFile(args.root, args.rel); return {};
      case 'truncate': await this.truncate(args.root, args.rel, args.size); return {};
      case 'remove': await this.remove(args.root, args.rel); return {};
      case 'rename': await this.rename(args.rootFrom, args.relFrom, args.rootTo, args.relTo); return {};
      case 'open': return await this.openFile(args.root, args.rel, args.forWrite);
      case 'read': return await this.readFile(args.fd, args.position, args.length, data);
      case 'write': return await this.writeFile(args.fd, args.position, args.length, data);
      case 'close': return await this.closeFile(args.fd);
      case 'size': return this.fileSize(args.fd);
      default: throw new Error(`unknown filesystem operation "${op}"`);
    }
  }
}
