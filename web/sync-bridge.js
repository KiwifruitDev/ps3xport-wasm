// SharedArrayBuffer bridge that lets the WebAssembly worker call the main
// thread synchronously.
//
// The worker cannot use async APIs (the C core is a blocking, synchronous
// program), so every filesystem call is forwarded to the main thread, which
// performs the async File System Access work and wakes the worker up through
// Atomics. Only one call can be in flight at a time by construction: the
// worker is blocked while waiting.
//
// Layout of the SharedArrayBuffer:
//   0   STATUS   worker sets 1 before posting, server sets 0 when finished
//   4   RESULT   0 = ok, 1 = error
//   8   VALUE0   op-specific numeric result (bytes read, fd, ...)
//   12  VALUE1   op-specific numeric result
//   16  ERROR    error kind (see BRIDGE_ERRORS)
//   20..31       reserved
//   32..         data window

export const HEADER_BYTES = 32;
export const DATA_BYTES = 8 * 1024 * 1024;

export const BRIDGE_ERRORS = {
  NONE: 0,
  UNKNOWN: 1,
  NOT_FOUND: 2,
  EXISTS: 3,
  NOT_A_FILE: 4,
  NOT_A_DIR: 5,
  PERMISSION: 6,
};

// TextDecoder refuses views backed by a SharedArrayBuffer, so shared data has
// to be copied into ordinary memory before decoding.
export function copyOf(view) {
  const copy = new Uint8Array(view.length);
  copy.set(view);
  return copy;
}

export function createBridgeClient(sab, dataBytes = DATA_BYTES) {
  const ctrl = new Int32Array(sab, 0, 8);
  const data = new Uint8Array(sab, HEADER_BYTES, dataBytes);
  const decoder = new TextDecoder();
  let seq = 0;

  function call(op, args = {}) {
    ctrl[1] = 0;
    ctrl[2] = 0;
    ctrl[3] = 0;
    ctrl[4] = 0;
    ctrl[5] = 0;
    ctrl[6] = 0;

    Atomics.store(ctrl, 0, 1);
    postMessage({ type: 'io', seq: ++seq, op, args });

    while (Atomics.load(ctrl, 0) === 1) {
      Atomics.wait(ctrl, 0, 1);
    }

    if (ctrl[1] !== 0) {
      const detail = ctrl[6] > 0 ? decoder.decode(copyOf(data.subarray(0, ctrl[6]))) : '';
      const error = new Error(detail || `filesystem ${op} failed (code ${ctrl[4]})`);
      error.bridgeCode = ctrl[4];
      throw error;
    }
    return { n0: ctrl[2], n1: ctrl[3], n2: ctrl[5] };
  }

  return { call, data };
}

export function createBridgeServer(sab, dataBytes = DATA_BYTES) {
  const ctrl = new Int32Array(sab, 0, 8);
  const data = new Uint8Array(sab, HEADER_BYTES, dataBytes);
  const encoder = new TextEncoder();

  function respond(result, errorCode = 0) {
    ctrl[1] = errorCode ? 1 : 0;
    ctrl[2] = result?.n0 ?? 0;
    ctrl[3] = result?.n1 ?? 0;
    ctrl[4] = errorCode;
    ctrl[5] = result?.n2 ?? 0;
    ctrl[6] = 0;
    Atomics.store(ctrl, 0, 0);
    Atomics.notify(ctrl, 0);
  }

  function respondError(message, errorCode) {
    const text = encoder.encode(message.slice(0, 2048));
    if (text.length <= data.length) {
      data.set(text, 0);
      ctrl[6] = text.length;
    }
    ctrl[1] = 1;
    ctrl[2] = 0;
    ctrl[3] = 0;
    ctrl[4] = errorCode;
    ctrl[5] = 0;
    Atomics.store(ctrl, 0, 0);
    Atomics.notify(ctrl, 0);
  }

  // Returns true when the message was a bridge request.
  return async function handle(message, handler) {
    if (!message || message.type !== 'io') return false;
    try {
      const result = await handler(message, data);
      respond(result);
    } catch (error) {
      let code = BRIDGE_ERRORS.UNKNOWN;
      const name = error?.name;
      if (name === 'NotFoundError') code = BRIDGE_ERRORS.NOT_FOUND;
      else if (name === 'NotAllowedError' || name === 'SecurityError') code = BRIDGE_ERRORS.PERMISSION;
      else if (name === 'TypeMismatchError') code = BRIDGE_ERRORS.NOT_A_FILE;
      else if (error?.bridgeCode) code = error.bridgeCode;
      respondError(String(error?.message ?? error), code);
    }
    return true;
  };
}
