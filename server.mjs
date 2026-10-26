// Small static file server for ps3xport-wasm.
//
// The app needs a cross-origin isolated context (SharedArrayBuffer) and must be
// served over http://localhost or https. This server sends the required COOP
// and COEP headers.

import { createServer } from 'node:http';
import { createReadStream, statSync, existsSync } from 'node:fs';
import { extname, join, normalize, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';

const projectRoot = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(projectRoot, 'web');

const args = process.argv.slice(2);
const portArg = args.find(value => /^--port=/.test(value));
const port = Number(portArg ? portArg.split('=')[1] : process.env.PORT ?? 8080);
const shouldOpen = args.includes('--open');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
  '.dat': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function resolveFile(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const candidate = normalize(join(webRoot, decoded));
  if (!candidate.startsWith(webRoot + sep) && candidate !== webRoot) return null;
  return candidate;
}

const server = createServer((request, response) => {
  const filePath = resolveFile(request.url ?? '/');
  if (!filePath) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  let target = filePath;
  if (existsSync(target) && statSync(target).isDirectory()) target = join(target, 'index.html');

  if (!existsSync(target)) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
    return;
  }

  const stats = statSync(target);
  const type = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream';

  response.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stats.size,
    'Cache-Control': 'no-cache',
    // Required for SharedArrayBuffer / Atomics.wait.
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
    // The offline cache lives in the page's own scope.
    'Service-Worker-Allowed': '/',
  });
  createReadStream(target).pipe(response);
});

server.listen(port, '127.0.0.1', () => {
  const url = `http://localhost:${port}/`;
  console.log(`ps3xport-wasm running at ${url}`);
  console.log(`serving ${webRoot}`);
  if (shouldOpen && process.platform === 'win32') {
    exec(`start "" "${url}"`);
  }
});

server.on('error', error => {
  console.error(`Server error: ${error.message}`);
  process.exit(1);
});
