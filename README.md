# ps3export-wasm

`ps3xport` compiled to WebAssembly: a local file manager and editor for PS3
Backup Utility backups, running entirely in Chrome or Edge. Nothing is uploaded;
there is no backend, only a static file server.

## What it does

- **Open a backup folder** (`PS3/EXPORT/<timestamp>`) and read `archive.dat`
  into a working copy you can browse.
- **Browse it like a file manager**: folders, `..`, a breadcrumb path bar and
  back / forward / up / home navigation.
- **Create, import and edit files** - including a built-in text editor for
  files up to 8 MiB.
- **Create folders, rename and delete** anything in the working copy.
- **Multi-selection** with `Ctrl`+click, `Shift`+click, `Ctrl+A`, plus a
  properties dialog that shows sizes, modes, dates, the chunks a file lives in
  and, for new files, where they will be stored.
- **Download the whole working copy as a zip** (zip64, streamed).
- **Write incrementally**: renames only rewrite `archive.dat`, new files append
  to the last chunk (or start a new one) and only a delete or a size change
  rewrites the chunks after the affected file. Nothing is extracted.
- **Two delete modes**: *Unlink* drops only the index entry (instant, keeps the
  bytes) and *Erase* reclaims the space by rewriting the affected chunks.
  *Compact unlinked data* reclaims space later.
- **Hold Shift** while starting Write, Delete or Compact to skip its
  confirmation dialog.
- **Separate overall and per-chunk progress** with elapsed time, live speed and
  an ETA, plus a plan dialog that lists the chunks and files that will change.
- **Replace the working copy** with the contents of another zip or folder.
- **Create a brand new backup** from a content folder that mirrors the PS3
  filesystem.
- **Install as an app / work offline**: a service worker caches the page, so it
  keeps working without a network connection after the first visit.
- **Menu bar + toolbar**: daily actions stay on the toolbar (open, navigation,
  path, write), everything else lives in the File / Edit / View menus.
- **Modal dialogs, toasts and progress** for every long operation, with cancel
  support for zips and chunk generation.

`keys.conf` is compiled into the wasm binary, so **you never provide keys**.
Normal backups need no console-specific keys: `archive.dat` and
`archive_*.dat` use the static `sc` key.

### Copy-protected content is opt-in

Copy-protected content (`archive2.dat`, `archive2_*.dat`) is encrypted with the
console Device ID. It is **ignored by default**. Enable *Advanced mode* in
*View → Settings* and paste your Device ID / IDP to include those files. When
advanced mode is off, writing a backup that contains copy-protected content
drops it - the confirmation dialog says so.

## Arkham: Revived PS3 patcher

[`arkham-patcher/`](./arkham-patcher) builds the browser patcher served at
<https://kiwifruitdev.com/arkhamrevived/ps3-tutorial/>. It downloads the
official 1.06 title update, patches its COALESCED files, and either merges them
into a Backup Utility archive (reusing this project's WebAssembly core and
incremental writer) or offers a zip for CFW/HEN consoles. Its build artifacts
live under `kiwifruitdev.com/public/arkhamrevived/ps3-tutorial/app/`; see
[arkham-patcher/README.md](./arkham-patcher/README.md).

## Requirements

- Node.js 20+ (developed against Node 26)
- Google Chrome or Microsoft Edge (the File System Access API and
  `SharedArrayBuffer` are required)
- [Emscripten SDK](https://emscripten.org/) only if you want to rebuild the
  WebAssembly module

## Quick start

```powershell
npm install        # only needed for the browser test
npm run build      # rebuild web/ps3xport.mjs + web/ps3xport.wasm (needs Emscripten)
npm start          # serves http://localhost:8080 and opens Chrome
```

`npm run serve` starts the server without opening a browser. The build outputs
are committed, so `npm start` works straight after cloning.

The server is required: the app needs a cross-origin isolated context
(`Cross-Origin-Opener-Policy` + `Cross-Origin-Embedder-Policy`) so that the
worker can block on `Atomics.wait` while the page reads your files. Opening
`index.html` from disk or serving it without those headers shows an explanation
instead of the UI.

## Using it

1. **Open** the folder containing `archive.dat` (for example
   `D:\PS3\EXPORT\202610241324`). Chrome asks for read/write access because
   *Write* can replace the archive files.
2. **Browse** with double-click, `..`, the breadcrumb bar, or the navigation
   buttons. `Ctrl+L` (or the pencil button) turns the path bar into an editable
   path.
3. **Edit** a text file by double-clicking it. `Ctrl+S` in the editor saves to
   the working copy - not to disk. Binary files and files above 8 MiB can be
   downloaded instead of edited.
4. **Add content** with *Edit → New file / New folder / Import files / Import
   folder*. Imported files are kept in memory until you write.
5. **Download** the working copy as a zip from the toolbar button or
   *File → Download as zip*.
6. **Write** (`Ctrl+S` outside the editor) to update the archive in the folder
   you opened (or a folder you pick). The plan dialog shows which chunks and
   files change, with an estimated duration.

### Working copy semantics

Opening a backup reads only the index into memory; file contents stay in the
original archive and are streamed when you open, zip or write them. Edits,
imports and new files live in memory as Blobs until you write.

A PS3 data archive has no per-file offsets: the position of every file is
implied by the order and sizes of the entries before it, and each chunk is a
separately encrypted/HMAC'd file. That makes some updates cheap and others
expensive:

| Change | What is rewritten |
| --- | --- |
| Rename | `archive.dat` only |
| Unlink (delete, keep bytes) | `archive.dat` only, with a hidden tombstone entry |
| Add files | the last chunk, or a brand new chunk when it is exactly full |
| Replace a file, same size | only the chunk(s) holding that file |
| Erase / resize / compact | every chunk from the affected file to the end |

Unchanged files never pass through JavaScript: the core splices their bytes
straight from the old chunk into the new one. New or edited content is streamed
from its Blob in 4 MiB slices. Nothing is extracted.

Chunks that do not exist yet are written straight to their final name, so the
common append case needs no temporary space at all. Only chunks that replace an
existing file are produced in a hidden `.ps3export-out-*` folder first; it is
removed after the commit.

Every chunk except the last one is exactly `0xFFFFFE00` bytes (4 GiB − 512); a
chunk that becomes empty is removed. Files larger than the free space of a chunk
span a chunk boundary, which the file properties dialog shows explicitly.

If the write fails before the commit phase, the temporary folder is removed and
the device is untouched. A marker file is only left behind when the failure
happens while replacing the archive, so an interrupted commit can be spotted.

### Content folder layout

A content folder mirrors the PS3 filesystem, exactly like `ps3xport Add`:

```text
content/
├── dev_hdd0/
│   ├── home/00000001/savedata/...
│   └── game/...
└── dev_flash2/
    └── ...
```

New backups created with *File → Create backup from folder…* are written into a
`YYYYMMDDHHmm` subfolder of the output folder, matching the PS3's own naming.

## Memory and large backups

The page never holds a whole backup in RAM:

- The working copy stores metadata only; contents are referenced by their source
  (archive entry, zip entry, folder file, or in-memory blob).
- All archive reads and writes are chunked through the 8 MiB SharedArrayBuffer
  bridge, and direct folder copies use 4 MiB slices.
- Zip output is assembled from Blob parts (browsers spill large blobs to disk)
  and never from one giant `ArrayBuffer`.
- Zip input is decompressed per entry on demand.

Incremental writes never extract the archive, so they need no staging copy of
the current contents. The temporary folder only holds the chunks being
produced, and the peak extra space on the device is the size of the rewritten
tail (one chunk for an append, more when erasing early data).

## Offline use and installation

The page is a static site with no backend. `sw.js` caches the HTML, scripts and
the WebAssembly binary, so after the first visit it works offline and browsers
can install it as an app (*View → Install app*, or the address bar's install
button). The canonical address is
<https://kiwifruitdev.com/tools/ps3export>; the same files also run from any
static host that sends the COOP/COEP headers used by `server.mjs`.

## Safety notes

- Writes always go through the browser's `FileSystemWritableFileStream`, never
  through a native path.
- A write only touches `archive.dat` / `archive2.dat` and the `archive_*.dat`
  chunks that actually change. Keep a second copy of anything you cannot afford
  to lose.
- New chunks are produced in a hidden folder first; the old chunks and index are
  replaced only when every new chunk has been written successfully.
- Copy-protected content is only included when advanced mode is on and a Device
  ID is configured. If it is off, `archive2*.dat` is left completely untouched.

## Project layout

```text
src/core/       upstream ps3xport C sources (aes, sha1, tools, keys, paged_file,
                archive, vtrm) with minimal portability patches
src/wasm/       api.c (flat C API for JavaScript) + px_platform.h
web/            static app: UI, worker, filesystem driver, wasm output
  app.js          panel controller: browsing, editing, writing, commands
  layout.js       chunk layout + incremental write planner
  writer.js       executes a plan through the wasm chunk writer
  ui.js           menus, dialogs, toasts, progress, context menus
  vfs.js          in-memory working copy + PXFS host adapter
  zip.js          streaming zip writer (zip64) and reader
  engine.js       worker client + host router (real folders / memory trees)
  worker.js       wasm host, mounts roots, exposes RPC commands
  pxfs.js         Emscripten filesystem driver
  host-directory.js  main-thread host backed by File System Access handles
  host-remote.js  worker-side synchronous host over SharedArrayBuffer
  manifest.webmanifest, sw.js, icons/   installable/offline app
scripts/        build-wasm.mjs (Emscripten build)
test/           Node + Chrome end-to-end tests
server.mjs      static server with COOP/COEP headers
arkham-patcher/ the Arkham: Revived PS3 patcher page (separate build)
```

## Building the WebAssembly module

```powershell
node scripts/build-wasm.mjs --debug   # assertions + safe heap
node scripts/build-wasm.mjs           # release
```

The script locates Emscripten through `EMSDK`, `%USERPROFILE%\emsdk`, `emcc` on
`PATH`, or `--emcc <path>`. It also generates
`build/generated/keys_conf_blob.h` so `src/core/keys.conf` is embedded in the
binary.

## Tests

```powershell
npm test                # core: create/extract/add/delete/verify in Node
npm run test:bridge     # the browser path: worker + SharedArrayBuffer bridge
npm run test:incremental  # layout mapping + incremental chunk/index writes
npm run test:browser    # real Chrome: drives the UI against OPFS
```

`test:incremental` builds an archive with small chunks (4 KiB) so it can verify
multi-chunk files, append, rename, in-place replacement, erase, unlink,
compaction and the chunk-size invariant without gigabytes of data.

`test:browser` needs Chrome or Edge. It starts the local server on a free port,
seeds an OPFS content tree, creates a backup through the UI, then exercises
navigation, the editor, imports, deletes, the zip download (verified entry by
entry in Node), the write-back rebuild and opening a zip. Set `PX_VERBOSE=1` to
dump the activity log when a test fails.

## Credits and licence

- Web panel (the UI in `web/`) © 2026
  [KiwifruitDev](https://github.com/KiwifruitDev), released under the MIT
  licence - see [web/LICENSE](./web/LICENSE).
- The ported `ps3xport` core (GPLv3), the WebAssembly glue and the filesystem
  driver come from [kakaroto/ps3xport](https://github.com/kakaroto/ps3xport) and
  remain under the GPLv3 - see `COPYING`.
