# Architecture notes

## Goal

Run the upstream `ps3xport` C core in the browser without rewriting it and
without ever loading a multi-gigabyte backup into memory, while presenting the
backup as an editable file browser.

## Layering

```text
  Browser UI (web/app.js, web/ui.js)
        │  browsing, editing, zip, write-back, dialogs
        ▼
  Working copy (web/vfs.js)  ← in-memory tree of paths + content sources
        │  also exposed as a PXFS host for the wasm core
        ▼
  Web worker (web/worker.js)
        │  1. imports the wasm module
        │  2. mounts roots into the Emscripten VFS
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
  Main-thread host router (web/engine.js)
        │  real folders → host-directory.js   memory trees → vfs.js
        ▼
  User's USB drive / folder, or zip data
```

### Roots

| Root | Host | Purpose |
| --- | --- | --- |
| `usb` | `DirectoryHost` | the backup folder the user opened (or a replacement source) |
| `zip` | `MemoryHost` | entries of an imported zip file |
| `scratch` | `MemoryHost` | single-file extracts that are handed back to the page as a Blob |
| `out` | `DirectoryHost` | hidden folder for the chunks and index being produced |
| `content` | `DirectoryHost` | content folder for *Create backup from folder* |
| `extract` | `DirectoryHost` | test-only destination for full extractions |

The bridge protocol routes `stat`/`readdir`/`mkdir`/… by `args.root`. `read`,
`write`, `close` and `size` only carry a file descriptor, so `host-remote.js`
remembers the root each descriptor was opened with and forwards it; the router in
`engine.js` then picks the right host.

### Why the core runs unmodified

`pxfs.js` registers a custom Emscripten filesystem and mounts one host per root.
Because `fopen`, `stat`, `opendir`, `rename` and friends are resolved by the
VFS, the upstream code keeps using ordinary POSIX calls, and paths such as
`/px/usb/archive_00.dat` behave like real files. Only four small portability
patches were needed:

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

## The working copy

`web/vfs.js` holds the tree the user browses. Nodes are directories or files;
files carry a *content source* and are materialised on demand:

| Source | Meaning | Materialised by |
| --- | --- | --- |
| `blob` | edited, imported or newly created file | already in memory |
| `archive` | still inside `archive.dat` / `archive2.dat` | `px_extract_file` into `scratch` |
| `handle` | a file in a folder the user picked | `File.slice().arrayBuffer()` |
| `zip` | an entry of an imported zip | `DecompressionStream` on demand |

Opening a backup therefore only decodes the index. Files are pulled from the
archive when they are opened, zipped or written, so a 30 GB backup costs a few
megabytes of metadata. Each `archive` source keeps its original path
(`srcPath`), which is what makes renames cheap: the tree path changes, the
archive lookup does not.

The same object is exposed as a `MemoryHost`, so the core can mount it (used for
zip input and scratch space). Sequential writes are collected as Blob parts;
random-access writes fall back to a growable buffer, which is fine because only
small index files take that path.

## Writing back to the device

Archives have no per-file offsets. `archive_find_file()` walks the index and
advances through the data chunks using the entry sizes and the actual chunk
sizes on disk, so a file's position is implied by everything before it. Each
chunk is AES-CBC encrypted and HMAC-SHA1 authenticated as a single file, which
means a chunk cannot be appended to: any change to a chunk rewrites it
completely.

`web/layout.js` reproduces the core's position walk (`layoutArchive`) and turns
the working copy into a plan that rewrites as little as possible:

| Change | Plan |
| --- | --- |
| nothing | `none` - no write at all |
| rename | index entries only |
| unlink | index entry replaced by a hidden tombstone, layout untouched |
| add | rewrite the last chunk and/or append new chunks |
| replace (same size) | rewrite only the chunks holding the file |
| erase / resize | rewrite from the first affected file's chunk to the end |
| full rebuild (write to another folder) | rewrite every chunk |

The append position follows `archive_find_file()` exactly: if the last file
ends at a chunk boundary the core expects the next file at offset `0x50` of a
new chunk, otherwise it expects it right after the last one. This is why appending
usually does not touch any existing chunk (the PS3's own last chunk ends exactly
at the end of the last file), and why the planner never pads a chunk.

`web/writer.js` executes a plan. For every chunk it calls the new C API:

```text
px_chunk_begin(path, archive_id, index, archive_type, cap)
px_chunk_write(pointer, length)          new/edited bytes from a Blob
px_chunk_copy(path, offset, length)      unchanged bytes spliced from an old chunk
px_chunk_finish()                        flush, patch the HMAC at offset 8
```

Unchanged files therefore never pass through JavaScript. The index itself is
edited in place in the wasm core (`px_index_remove_file`,
`px_index_rename_file`, `px_index_update_file`, `px_index_add_file`, directory
table rebuild) and saved with the existing `archive_index_write`.

A chunk whose file name does not exist in the destination is written straight
to its final name. Chunks that replace an existing file are produced in
`.ps3xport-out-<stamp>` first, together with the new index, so an interrupted
generation leaves the old archive intact. The plan dialog shows the affected
chunks and their files and an ETA. On success the staged chunks replace the old
ones, the index is written last, chunks that became empty are removed and the
temporary folder is deleted. A `.ps3xport-journal-<stamp>.json` marker exists
only while a commit is in progress.

Copy-protected content is only part of a plan when advanced mode loaded
`archive2.dat`; otherwise those files and chunks are left completely untouched.

## Zip support

`web/zip.js` implements both directions without dependencies:

- Writer: stored (uncompressed) entries, CRC-32 computed by streaming Blob
  chunks, zip64 extra fields and end records when sizes, offsets or entry counts
  need them. Output is assembled as Blob parts and handed to a Blob URL.
- Reader: end-of-central-directory scan (plus zip64 locator), central directory
  parse, and per-entry `getBlob()` that slices the compressed range and inflates
  it with `DecompressionStream('deflate-raw')` once, caching the result.

## Keys

`scripts/build-wasm.mjs` converts `src/core/keys.conf` into
`build/generated/keys_conf_blob.h`, which `px_init()` writes into the in-memory
filesystem at `/keys.conf` and hands to `keys_set_path()`. Users never supply
keys.

`archive.dat` and `archive_*.dat` use `ENCRYPTION_TYPE_KEYSEED`, derived from the
key seed in the file header and the static `sc` keys in `keys.conf`. That is why
extraction and creation work with no console-specific keys.

`archive2*.dat` use `ENCRYPTION_TYPE_IDP` and are ignored unless *Advanced mode*
is enabled and a Device ID is configured. The Device ID is stored in
`localStorage` and only passed to the wasm core, never sent anywhere.

## Safety model

1. Reads go through `File.slice(...).arrayBuffer()`; nothing is buffered whole.
2. Writes go through `FileSystemWritableFileStream`; a folder is only writable
   after the user grants it in the picker.
3. Edits stay in memory until `Write`; the rebuild happens in temporary folders.
4. Deleting or renaming only affects the working copy until `Write`.
5. Content over 8 MiB (or non-UTF-8 content) is never loaded into the editor.

## Error handling

`px_die()` records the message, appends the current `errno`, and `longjmp`s to
the API boundary, which returns `-1`. The JS side then throws, the worker
reports it through the RPC channel, and the UI shows a toast plus an entry in
the activity log. A failed call never traps the module, so the same page can
retry.

## Re-mounting folders

Choosing a different folder for the same root re-mounts the PXFS in the worker.
Without that, Emscripten's cached directory nodes would still point at the
previous folder. The write flow mounts a fresh hidden `out` folder for every
write for the same reason.

## Progress reporting

The page never learns how far the core is from the core itself. Instead the
main-thread host counts bytes read and written by the bridge
(`DirectoryHost.activity`), and `createProgress` samples that counter while a
blocking RPC runs. Chunk generation and index writes are therefore measured
directly, while the commit phase (page-to-page copies) advances the counter from
its own `FileSystemWritableFileStream` writes. The dialog shows an overall bar,
a bar for the current chunk, the elapsed time and an ETA derived from an
exponential moving average of the fraction rate. The learned throughput is kept
in `localStorage` and used for the estimate in the plan dialog.

## Offline app

`web/sw.js` pre-caches every static asset under a versioned cache name and
serves it cache-first; navigations fall back to `index.html`. The manifest and
icons make the page installable. The service worker only handles the app shell:
archive data is accessed exclusively through the File System Access API.
