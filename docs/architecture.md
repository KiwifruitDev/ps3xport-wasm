# Architecture notes

## Goal

Run the upstream `ps3xport` C core in the browser without rewriting it and
without ever loading a multi-gigabyte backup into memory.

## Layering

```text
  Chrome UI (web/app.js)
        │  High level RPC: listIndex / extractAll / createBackup / ...
        ▼
  Web worker (web/worker.js)
        │  1. imports the wasm module
        │  2. mounts user directories into the Emscripten VFS
        │  3. calls the flat C API in src/wasm/api.c
        ▼
  ps3xport core (src/core/*.c)  ← unmodified upstream logic
        │  fopen / fread / fwrite / fseek / stat / opendir / rename
        ▼
  PXFS driver (web/pxfs.js)     ← Emscripten filesystem implementation
        │  synchronous host interface
        ▼
  SharedArrayBuffer bridge (web/sync-bridge.js, web/host-remote.js)
        │  Atomics.wait + postMessage
        ▼
  Main thread host (web/host-directory.js)
        │  async File System Access API calls
        ▼
  User's USB drive / folder
```

### Why the core runs unmodified

`pxfs.js` registers a custom Emscripten filesystem and mounts one host directory
per root (`/px/backup`, `/px/out`, `/px/content`). Because `fopen`, `stat`,
`opendir`, `rename` and friends are resolved by the VFS, the upstream code keeps
using ordinary POSIX calls, and paths such as `/px/backup/archive_00.dat` behave
like real files. Only four small portability patches were needed:

| File | Patch |
| --- | --- |
| `src/core/paged_file.c` | `fseeko`/`ftello` so archive offsets are 64-bit (wasm32 `long` is 32-bit) |
| `src/core/tools.h` | `die()` routes to `px_die()` so failures surface as errors instead of `exit()` |
| `src/core/tools.c` | `get_rand()` uses `crypto.getRandomValues`; unused `zlib.h` include removed |
| `src/core/archive.c` | `populate_dirlist()` stats entries when `PX_STAT_DIRENT` is defined (no reliable `d_type`) |

### Why a worker plus SharedArrayBuffer

The C core is a blocking program: `fread` must return data before the next
instruction runs. The File System Access API is asynchronous and only available
on the main thread. The bridge solves this by running the wasm in a worker and
sending each filesystem call to the page, where it is awaited and completed; the
worker parks on `Atomics.wait` until the answer arrives.

Consequences:

- The page must be cross-origin isolated, so `server.mjs` sends
  `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`.
- Only one call is in flight at a time, which is safe because the worker is
  blocked while waiting.
- No 4 GB allocation is needed: the core reads 4 KiB pages and the bridge moves
  data through an 8 MiB `SharedArrayBuffer`.

### Throughput

`host-remote.js` adds a 1 MiB read-ahead window and coalesces writes into 1 MiB
transfers. That keeps the number of worker↔page round trips proportional to
megabytes instead of to the core's 4 KiB page size.

## Keys

`scripts/build-wasm.mjs` converts `src/core/keys.conf` into
`build/generated/keys_conf_blob.h`, which `px_init()` writes into the in-memory
filesystem at `/keys.conf` and hands to `keys_set_path()`. Users never supply
keys.

`archive.dat` and `archive_*.dat` use `ENCRYPTION_TYPE_KEYSEED`, derived from the
key seed in the file header and the static `sc` keys in `keys.conf`. That is why
extraction and creation work with no console-specific keys. `archive2*.dat` use
`ENCRYPTION_TYPE_IDP` and therefore need the optional Device ID.

## Safety model

1. Reads go through `File.slice(...).arrayBuffer()`; nothing is buffered whole.
2. Writes go through `FileSystemWritableFileStream`; the folder is only writable
   after the user grants it in the picker.
3. Extraction and new backups always target the output folder the user chose.
4. Editing an index rewrites only `archive.dat` (or `archive.bak` copies the core
   leaves behind); data segments are not rewritten when deleting.
5. Index writes patch the HMAC at offset 8 after streaming, which is why the
   writable stream is opened with `keepExistingData: true`.

## Error handling

`px_die()` records the message, appends the current `errno`, and `longjmp`s to
the API boundary, which returns `-1`. The JS side then throws, the worker
reports it through the RPC channel, and the UI shows it in the activity log. A
failed call never traps the module, so the same page can retry.

## Re-mounting folders

Choosing a different folder for the same root re-mounts the PXFS in the worker.
Without that, Emscripten's cached directory nodes would still point at the
previous folder.
