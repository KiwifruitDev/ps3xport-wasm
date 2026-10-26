// Worker-side host implementation: presents the synchronous host interface
// expected by pxfs.js on top of the SharedArrayBuffer bridge.
//
// Reads are served from a read-ahead window and writes are coalesced into
// large transfers, which keeps the number of round trips to the main thread
// proportional to megabytes rather than to the core's 4 KiB page size.

import { copyOf } from './sync-bridge.js';

const READ_AHEAD = 1 << 20;
const WRITE_COALESCE = 1 << 20;

export function createRemoteHost(client) {
  const states = new Map();

  const stateOf = fd => {
    let state = states.get(fd);
    if (!state) {
      state = { root: null, readStart: -1, readData: null, writeStart: -1, parts: [], writeLength: 0 };
      states.set(fd, state);
    }
    return state;
  };

  function flush(fd) {
    const state = stateOf(fd);
    if (state.writeLength === 0) return;
    let offset = state.writeStart;
    for (const part of state.parts) {
      let inner = 0;
      while (inner < part.length) {
        const take = Math.min(client.data.length, part.length - inner);
        client.data.set(part.subarray(inner, inner + take), 0);
        client.call('write', { root: state.root, fd, position: offset, length: take });
        inner += take;
        offset += take;
      }
    }
    state.writeStart = -1;
    state.parts = [];
    state.writeLength = 0;
  }

  function flushAll() {
    for (const fd of states.keys()) flush(fd);
  }

  const host = {
    stat(root, rel) {
      flushAll();
      const { n0, n1, n2 } = client.call('stat', { root, rel });
      if ((n0 & 1) === 0) return null;
      return {
        isDir: (n0 & 2) !== 0,
        size: (n1 >>> 0) + (n2 >>> 0) * 0x100000000,
      };
    },

    readdir(root, rel) {
      flushAll();
      const { n0 } = client.call('readdir', { root, rel });
      if (!n0) return [];
      const text = new TextDecoder().decode(copyOf(client.data.subarray(0, n0)));
      return JSON.parse(text);
    },

    mkdir(root, rel) {
      flushAll();
      client.call('mkdir', { root, rel });
    },

    createFile(root, rel) {
      flushAll();
      client.call('createFile', { root, rel });
    },

    truncate(root, rel, size) {
      flushAll();
      client.call('truncate', { root, rel, size });
    },

    remove(root, rel) {
      flushAll();
      client.call('remove', { root, rel });
    },

    rename(rootFrom, relFrom, rootTo, relTo) {
      flushAll();
      client.call('rename', { rootFrom, relFrom, rootTo, relTo });
    },

    open(root, rel, forWrite) {
      flushAll();
      const { n0, n1 } = client.call('open', { root, rel, forWrite });
      stateOf(n0).root = root;
      return n0;
    },

    close(fd) {
      const state = stateOf(fd);
      flush(fd);
      client.call('close', { root: state.root, fd });
      states.delete(fd);
    },

    fdSize(fd) {
      const state = stateOf(fd);
      flush(fd);
      const { n0, n1 } = client.call('size', { root: state.root, fd });
      return (n0 >>> 0) + (n1 >>> 0) * 0x100000000;
    },

    read(fd, position, length, target) {
      const state = stateOf(fd);
      if (state.readData && position >= state.readStart &&
          position + length <= state.readStart + state.readData.length) {
        const from = position - state.readStart;
        target.set(state.readData.subarray(from, from + length), 0);
        return length;
      }

      const want = Math.max(length, READ_AHEAD);
      const { n0 } = client.call('read', { root: state.root, fd, position, length: want });
      state.readStart = -1;
      state.readData = null;
      if (n0 === 0) return 0;

      const chunk = client.data.slice(0, n0);
      state.readStart = position;
      state.readData = chunk;
      const available = Math.min(length, n0);
      target.set(chunk.subarray(0, available), 0);
      return available;
    },

    write(fd, position, data) {
      const state = stateOf(fd);
      if (state.writeStart >= 0 && position !== state.writeStart + state.writeLength) {
        flush(fd);
      }
      if (state.writeStart < 0) state.writeStart = position;
      state.parts.push(data.slice());
      state.writeLength += data.length;
      if (state.writeLength >= WRITE_COALESCE) flush(fd);
    },

    flushAll,
  };

  return host;
}
