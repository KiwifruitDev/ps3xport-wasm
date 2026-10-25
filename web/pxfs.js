// Emscripten filesystem driver ("PXFS") that maps a mounted directory to a
// host object. The host object must expose *synchronous* operations; in the
// browser they are serviced by the main thread through a SharedArrayBuffer
// bridge, in tests by Node's synchronous fs API.
//
// Mounting the user's real directories this way means the upstream ps3xport C
// code runs unmodified: fopen/fread/fwrite/stat/opendir/rename all work as
// usual, and the core never needs to hold a whole archive in memory.

const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const O_ACCMODE = 3;
const O_WRONLY = 1;
const O_RDWR = 2;

// Match the enum in src/wasm/api.c (px_errno).
const ERRNO_INDEX = {
  ENOENT: 0,
  EEXIST: 1,
  ENOTDIR: 2,
  EISDIR: 3,
  EINVAL: 4,
  ENOSYS: 5,
  EBADF: 6,
  ENODEV: 7,
  EACCES: 8,
  EPERM: 9,
  EBUSY: 10,
  EIO: 11,
};

function resolveErrnoTable(Module) {
  if (typeof Module._px_errno === 'function') {
    const table = {};
    for (const [name, index] of Object.entries(ERRNO_INDEX)) {
      table[name] = Module._px_errno(index);
    }
    return table;
  }
  return Module.ERRNO_CODES;
}

export function installPxfs(Module, host) {
  const FS = Module.FS;
  const ERRNO = resolveErrnoTable(Module);

  const fail = name => new FS.ErrnoError(ERRNO[name]);

  function locate(node) {
    const parts = [];
    let current = node;
    while (current.parent !== current) {
      parts.push(current.name);
      current = current.parent;
    }
    parts.reverse();
    return { root: node.mount.opts.root, rel: parts.join('/') };
  }

  function statOf(node) {
    const { root, rel } = locate(node);
    const info = host.stat(root, rel);
    if (!info) throw fail('ENOENT');
    return info;
  }

  function attrFor(node, info) {
    const stamp = new Date(info.mtimeMs || Date.now());
    return {
      dev: 1,
      ino: node.id,
      mode: (info.isDir ? S_IFDIR | 0o777 : S_IFREG | 0o666),
      nlink: 1,
      uid: 0,
      gid: 0,
      rdev: 0,
      size: info.isDir ? 4096 : info.size,
      atime: stamp,
      mtime: stamp,
      ctime: stamp,
      blksize: 4096,
      blocks: Math.ceil((info.isDir ? 0 : info.size) / 4096),
    };
  }

  function newNode(parent, name, info) {
    const mode = info.isDir ? S_IFDIR | 0o777 : S_IFREG | 0o666;
    const node = FS.createNode(parent, name, mode, 0);
    node.pxfs = { info };
    node.node_ops = PXFS.node_ops;
    node.stream_ops = PXFS.stream_ops;
    return node;
  }

  function dropCache(node) {
    if (node && node.pxfs) node.pxfs.children = null;
  }

  const PXFS = {
    mount(mount) {
      const root = FS.createNode(null, '/', S_IFDIR | 0o777, 0);
      root.node_ops = PXFS.node_ops;
      root.stream_ops = PXFS.stream_ops;
      root.pxfs = { info: { isDir: true, size: 0, mtimeMs: Date.now() } };
      mount.opts = mount.opts || {};
      return root;
    },

    node_ops: {
      getattr(node) {
        return attrFor(node, statOf(node));
      },

      setattr(node, attr) {
        const { root, rel } = locate(node);
        if (attr.size !== undefined && attr.size !== null) {
          host.truncate(root, rel, attr.size);
          node.pxfs.info.size = attr.size;
        }
        if (attr.mode !== undefined) node.mode = (node.mode & ~0o777) | (attr.mode & 0o777);
        node.pxfs.info.mtimeMs = Date.now();
      },

      lookup(parent, name) {
        const cached = parent.pxfs?.children?.get(name);
        if (cached) {
          return newNode(parent, name, cached);
        }

        const { root, rel } = locate(parent);
        const childRel = rel === '' ? name : `${rel}/${name}`;
        const info = host.stat(root, childRel);
        if (!info) throw fail('ENOENT');
        return newNode(parent, name, info);
      },

      mknod(parent, name, mode) {
        const { root, rel } = locate(parent);
        const childRel = rel === '' ? name : `${rel}/${name}`;
        if (FS.isDir(mode)) host.mkdir(root, childRel);
        else host.createFile(root, childRel);
        dropCache(parent);
        return newNode(parent, name, { isDir: FS.isDir(mode), size: 0, mtimeMs: Date.now() });
      },

      mkdir(parent, name) {
        const { root, rel } = locate(parent);
        const childRel = rel === '' ? name : `${rel}/${name}`;
        host.mkdir(root, childRel);
        dropCache(parent);
        return newNode(parent, name, { isDir: true, size: 0, mtimeMs: Date.now() });
      },

      rename(oldNode, newDir, newName) {
        const from = locate(oldNode);
        const toDir = locate(newDir);
        const toRel = toDir.rel === '' ? newName : `${toDir.rel}/${newName}`;
        host.rename(from.root, from.rel, toDir.root, toRel);
        dropCache(newDir);
        dropCache(oldNode.parent);
        oldNode.name = newName;
        oldNode.parent = newDir;
      },

      unlink(parent, name) {
        const { root, rel } = locate(parent);
        const childRel = rel === '' ? name : `${rel}/${name}`;
        host.remove(root, childRel);
        dropCache(parent);
      },

      rmdir(parent, name) {
        const { root, rel } = locate(parent);
        const childRel = rel === '' ? name : `${rel}/${name}`;
        host.remove(root, childRel);
        dropCache(parent);
      },

      readdir(node) {
        const { root, rel } = locate(node);
        const entries = host.readdir(root, rel);
        const children = new Map();
        for (const entry of entries) children.set(entry.name, entry);
        node.pxfs.children = children;
        return entries.map(entry => entry.name);
      },

      statfs() {
        return { bsize: 4096, frsize: 4096, blocks: 0, bfree: 0, bavail: 0, files: 0, ffree: 0, fsid: 1, flags: 0, namelen: 255 };
      },

      symlink() {
        throw fail('ENOSYS');
      },

      readlink() {
        throw fail('EINVAL');
      },
    },

    stream_ops: {
      getattr(stream) {
        return attrFor(stream.node, statOf(stream.node));
      },

      open(stream) {
        // Directory streams (opendir) need no host file descriptor: the entries
        // are fetched by node_ops.readdir.
        if (FS.isDir(stream.node.mode)) {
          stream.pxfs = { fd: undefined, directory: true };
          return;
        }
        const write = (stream.flags & O_ACCMODE) === O_WRONLY ||
          (stream.flags & O_ACCMODE) === O_RDWR;
        const { root, rel } = locate(stream.node);
        stream.pxfs = { fd: host.open(root, rel, write), directory: false };
      },

      close(stream) {
        if (stream.pxfs && stream.pxfs.fd !== undefined) {
          host.close(stream.pxfs.fd);
          stream.pxfs.fd = undefined;
        }
      },

      read(stream, buffer, offset, length, position) {
        if (stream.pxfs.directory) throw fail('EISDIR');
        const fd = stream.pxfs.fd;
        const at = position === undefined ? stream.position : position;
        const view = buffer.subarray(offset, offset + length);
        const read = host.read(fd, at, length, view);
        if (position === undefined) stream.position += read;
        return read;
      },

      write(stream, buffer, offset, length, position) {
        if (stream.pxfs.directory) throw fail('EISDIR');
        const fd = stream.pxfs.fd;
        const at = position === undefined ? stream.position : position;
        const data = buffer.subarray(offset, offset + length);
        host.write(fd, at, data);
        if (position === undefined) stream.position += length;
        return length;
      },

      llseek(stream, offset, whence) {
        const SEEK_SET = 0;
        const SEEK_CUR = 1;
        const SEEK_END = 2;
        let position = offset;

        if (whence === SEEK_CUR) position += stream.position;
        else if (whence === SEEK_END) {
          position += stream.pxfs.directory ? 0 : host.fdSize(stream.pxfs.fd);
        }

        if (position < 0) throw fail('EINVAL');
        return position;
      },

      fsync() {
        return 0;
      },

      mmap() {
        throw fail('ENODEV');
      },

      msync() {
        return 0;
      },
    },
  };

  if (!FS.filesystems) FS.filesystems = {};
  FS.filesystems.PXFS = PXFS;
  Module.PXFS = PXFS;
  return PXFS;
}

// Creates the /px tree and mounts one host root per name.
export function mountHostRoots(Module, host, names) {
  const FS = Module.FS;
  const PXFS = Module.PXFS || installPxfs(Module, host);

  if (!FS.analyzePath('/px').exists) FS.mkdir('/px');
  for (const name of names) {
    const mountpoint = `/px/${name}`;
    if (!FS.analyzePath(mountpoint).exists) FS.mkdir(mountpoint);
    FS.mount(PXFS, { root: name }, mountpoint);
  }
}

