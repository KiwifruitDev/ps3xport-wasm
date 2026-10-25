// Node adapter that makes web/worker.js runnable inside a worker_threads worker.
// It only provides the two globals the browser worker API exposes.

import { parentPort } from 'node:worker_threads';

globalThis.self = globalThis;
globalThis.postMessage = message => parentPort.postMessage(message);
parentPort.on('message', data => {
  globalThis.onmessage?.({ data });
});

await import('../web/worker.js');
