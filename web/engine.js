// Connects the page to the WebAssembly worker.
//
// The Engine owns the worker, the SharedArrayBuffer bridge and the
// main-thread filesystem host. All archive work happens inside the worker;
// the page only asks for high level operations.

import { createBridgeServer, DATA_BYTES, HEADER_BYTES } from './sync-bridge.js';
import { DirectoryHost } from './host-directory.js';

// Routes bridge operations to the host that owns the requested root, so both
// real folders (DirectoryHost) and in-memory trees (MemoryHost) can be mounted.
class Router {
  constructor(primary) {
    this.primary = primary;
    this.virtual = new Map();
  }

  mount(name, host) {
    this.virtual.set(name, host);
  }

  async dispatch(op, args, data) {
    const key = args.root ?? args.rootFrom;
    if (key && this.virtual.has(key)) return await this.virtual.get(key).dispatch(op, args, data);
    return await this.primary.dispatch(op, args, data);
  }
}

export class Engine {
  constructor({ onProgress } = {}) {
    this.onProgress = onProgress;
    this.host = new DirectoryHost();
    this.host.onProgress = bytes => this.onProgress?.(bytes);
    this.router = new Router(this.host);
    this.pending = new Map();
    this.nextRequestId = 1;
    this.ready = null;
    this.worker = null;
    this.sab = null;
  }

  start() {
    if (this.ready) return this.ready;

    this.sab = new SharedArrayBuffer(HEADER_BYTES + DATA_BYTES);
    const bridge = createBridgeServer(this.sab, DATA_BYTES);

    this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });

    this.ready = new Promise((resolve, reject) => {
      this.worker.onerror = event => reject(new Error(event.message || 'worker failed to start'));
      this.worker.onmessage = async event => {
        const message = event.data;
        if (!message || typeof message !== 'object') return;

        if (message.type === 'io') {
          await bridge(message, (request, data) => this.router.dispatch(request.op, request.args, data));
          return;
        }

        if (message.type === 'ready') {
          resolve();
          return;
        }

        if (message.type === 'fatal') {
          reject(new Error(message.error));
          return;
        }

        if (message.type === 'rpc-result') {
          const entry = this.pending.get(message.id);
          if (!entry) return;
          this.pending.delete(message.id);
          if (message.ok) entry.resolve(message.result ?? {});
          else entry.reject(new Error(message.error || 'operation failed'));
          return;
        }

        if (message.type === 'mount-result') {
          const entry = this.pending.get(message.id);
          if (!entry) return;
          this.pending.delete(message.id);
          if (message.ok) entry.resolve();
          else entry.reject(new Error(message.error || 'mount failed'));
        }
      };

      this.worker.postMessage({ type: 'init', sab: this.sab });
    });

    return this.ready;
  }

  async setRoot(name, handle) {
    await this.start();
    const needsWrite = name === 'usb' || name === 'stage' || name === 'out' || name === 'backup' || name === 'device';
    if (needsWrite && typeof handle.requestPermission === 'function') {
      const status = await handle.queryPermission({ mode: 'readwrite' });
      if (status !== 'granted') {
        const granted = await handle.requestPermission({ mode: 'readwrite' });
        if (granted !== 'granted') throw new Error('Write permission was not granted for this folder.');
      }
    }
    this.host.setRoot(name, handle);
    await this.mount(name);
  }

  /** Mounts an in-memory host (MemoryHost) under a root name. */
  async mountMemory(name, host) {
    await this.start();
    this.router.mount(name, host);
    await this.mount(name);
  }

  mount(name) {
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'mount', id, name });
    });
  }

  rpc(cmd, args = {}, transfer = []) {
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'rpc', id, cmd, args }, transfer);
    });
  }

  resetProgress() {
    this.host.bytesMoved = 0;
    this.host.activity = { reads: 0, writes: 0, readPath: '', writePath: '' };
  }

  get bytesMoved() {
    return this.host.bytesMoved;
  }

  get activity() {
    return this.host.activity;
  }
}
