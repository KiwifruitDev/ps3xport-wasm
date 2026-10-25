# ps3export-wasm

`ps3xport` compiled to WebAssembly: a local file manager and editor for PS3
Backup Utility backups, running entirely in Chrome or Edge. Nothing is uploaded;
there is no backend, only a static file server.

## What it does

- **Open a backup folder** (`PS3/EXPORT/<timestamp>`) and read `archive.dat`
  into a working copy you can browse.
- **Browse it like a file manager**: folders, `..`, a breadcrumb path bar and
  back / forward / up / home navigation.
- **Create, import and edit files** — including a built-in text editor for
  files up to 8 MiB.
- **Create folders, rename and delete** anything in the working copy.
- **Download the whole working copy as a zip** (zip64, streamed).
- **Write the working copy back to the device**: the archive is rebuilt from
  scratch first, then `archive*.dat` on the USB folder is replaced.
- **Replace the working copy** with the contents of another zip or folder.
- **Create a brand new backup** from a content folder that mirrors the PS3
  filesystem.
- **Menu bar + toolbar**: daily actions stay on the toolbar (open, navigation,
  path, write), everything else lives in the File / Edit / View menus.
- **Modal dialogs, toasts and progress** for every long operation, with cancel
  support for zips.

`keys.conf` is compiled into the wasm binary, so **you never provide keys**.
Normal backups need no console-specific keys: `archive.dat` and
`archive_*.dat` use the static `sc` key.

### Copy-protected content is opt-in

Copy-protected content (`archive2.dat`, `archive2_*.dat`) is encrypted with the
console Device ID. It is **ignored by default**. Enable *Advanced mode* in
*View → Settings* and paste your Device ID / IDP to include those files. When
advanced mode is off, writing a backup that contains copy-protected content
drops it — the confirmation dialog says so.

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
   the working copy — not to disk. Binary files and files above 8 MiB can be
   downloaded instead of edited.
4. **Add content** with *Edit → New file / New folder / Import files / Import
   folder*. Imported files are kept in memory until you write.
5. **Download** the working copy as a zip from the toolbar button or
   *File → Download as zip*.
6. **Write** (`Ctrl+S` outside the editor) to rebuild the archive and replace
   `archive*.dat` in the folder you opened (or a folder you pick).

### Working copy semantics

Opening a backup reads only the index into memory; file contents stay in the
original archive and are streamed when you open, zip or write them. Edits,
imports and new files live in memory as Blobs until you write. *Write* therefore
performs a full rebuild:

1. extract the current archive into a hidden staging folder next to it,
2. apply your edits, imports and deletions,
3. build a new archive into a hidden output folder,
4. only then delete the old `archive*.dat` and move the new files into place,
5. clean up and reload.

The device is never left with a half-written index: if the build fails, the old
files are untouched.

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

Writing a very large backup still requires temporary disk space for the staging
folder plus the rebuilt archive, because the core rebuilds the whole archive.

## Safety notes

- Writes always go through the browser's `FileSystemWritableFileStream`, never
  through a native path.
- Rebuilding replaces `archive.dat`, `archive2.dat` and their `archive_*.dat`
  segments of the folder you write to. Keep a second copy of anything you
  cannot afford to lose.
- Deleted or renamed paths are pruned from the staging folder during a write;
  nothing is deleted on the device until the new archive is complete.
- Copy-protected content is only included when advanced mode is on and a Device
  ID is configured.

## Project layout

```text
src/core/       upstream ps3xport C sources (aes, sha1, tools, keys, paged_file,
                archive, vtrm) with minimal portability patches
src/wasm/       api.c (flat C API for JavaScript) + px_platform.h
web/            static app: UI, worker, filesystem driver, wasm output
  app.js          panel controller: browsing, editing, writing, commands
  ui.js           menus, dialogs, toasts, progress, context menus
  vfs.js          in-memory working copy + PXFS host adapter
  zip.js          streaming zip writer (zip64) and reader
  engine.js       worker client + host router (real folders / memory trees)
  worker.js       wasm host, mounts roots, exposes RPC commands
  pxfs.js         Emscripten filesystem driver
  host-directory.js  main-thread host backed by File System Access handles
  host-remote.js  worker-side synchronous host over SharedArrayBuffer
scripts/        build-wasm.mjs (Emscripten build)
test/           Node + Chrome end-to-end tests
server.mjs      static server with COOP/COEP headers
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
npm test               # core: create/extract/add/delete/verify in Node
npm run test:bridge    # the browser path: worker + SharedArrayBuffer bridge
npm run test:browser   # real Chrome: drives the UI against OPFS
```

`test:browser` needs Chrome or Edge. It starts the local server on a free port,
seeds an OPFS content tree, creates a backup through the UI, then exercises
navigation, the editor, imports, deletes, the zip download (verified entry by
entry in Node), the write-back rebuild and opening a zip. Set `PX_VERBOSE=1` to
dump the activity log when a test fails.

## Credits and licence

- Web panel (the UI in `web/`) © 2026
  [KiwifruitDev](https://github.com/KiwifruitDev), released under the MIT
  licence — see [web/LICENSE](./web/LICENSE).
- The ported `ps3xport` core (GPLv3), the WebAssembly glue and the filesystem
  driver come from [kakaroto/ps3xport](https://github.com/kakaroto/ps3xport) and
  remain under the GPLv3 — see `COPYING`.
