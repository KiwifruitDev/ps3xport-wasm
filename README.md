# ps3export-wasm

`ps3xport` compiled to WebAssembly: browse, extract and build PS3 Backup Utility
backups in Chrome, with all file access happening locally through the File System
Access API. Nothing is uploaded; there is no backend, only a static file server.

## What works

- Open a `PS3/EXPORT/<timestamp>` backup folder and list everything in
  `archive.dat` (paths, sizes, modes), including the backup ID, OpenPSID and
  copy-protected size.
- Extract one file, a path prefix, or the whole backup into a folder you choose.
- Create a brand new backup from a content folder.
- Append a content folder to an existing backup.
- Remove a file (or path) from the index, and drop the copy-protected reference.
- Decrypt an `archive[_NN].dat` (handy for inspection).

`keys.conf` is compiled into the wasm binary, so **you never provide keys**, and
normal (unprotected) backups need no console-specific keys at all: `archive.dat`
and `archive_*.dat` are encrypted with the static `sc` key from `keys.conf`.

Copy-protected content (`archive2.dat`, `archive2_*.dat`) is encrypted with the
console Device ID. Those files can only be read if you paste your Device ID /
IDP in the *Advanced* section; everything else works without it.

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
`index.html` from disk or serving it without those headers will show an
explanation instead of the UI.

## Using it

1. **Backup folder** — pick the folder containing `archive.dat`
   (e.g. `D:\PS3\EXPORT\202610241324`). Chrome asks for read/write access so the
   app can edit indexes.
2. **Contents** — the file list comes from the index inside the backup. Use the
   filter to narrow it down and click a row to select a single file.
3. **Output folder** — pick where extracted files and new backups go.
4. **Build** — pick a content folder, then either create a new backup in the
   output folder or append the content to the open backup.

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

New backups are named with a `YYYYMMDDHHmm` timestamp inside the output folder,
matching the PS3's own naming.

## Safety notes

- Writes always go through the browser's `FileSystemWritableFileStream`, never
  through a native path.
- The index is rewritten in place when you delete a file; the data segments are
  left untouched (deleting is implemented by pointing the entry at
  `/dev_hdd0/tmp/null`, exactly like upstream `ps3xport`).
- Appending to an existing backup rewrites the last segment and leaves a `.bak`
  copy, as upstream does.
- Keep a second copy of anything you cannot afford to lose.

## Project layout

```text
src/core/       upstream ps3xport C sources (aes, sha1, tools, keys, paged_file,
                archive, vtrm) with minimal portability patches
src/wasm/       api.c (flat C API for JavaScript) + px_platform.h
web/            static app: UI, worker, filesystem driver, wasm output
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

`test:browser` needs Chrome or Edge; it starts the local server on a free port,
seeds an OPFS content tree, creates a backup through the UI, and verifies the
extracted files by SHA-256.

## Licence

The ported core is GPLv3 (see `COPYING`), from
[kakaroto/ps3xport](https://github.com/kakaroto/ps3xport). The WebAssembly
glue, filesystem driver and UI are released under the same licence.
