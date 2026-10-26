// Executes an incremental write plan.
//
// The heavy lifting (encryption, HMAC, index serialisation) stays in the
// WebAssembly core. This module only streams the planned byte ranges into the
// new chunk files and reports progress: content items come from a Blob,
// copy items are spliced out of an existing chunk by the core so unchanged
// files never pass through JavaScript.

import { chunkName } from './layout.js';

const COPY_CHUNK = 4 * 1024 * 1024;

export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'AbortError';
  }
}

function checkCancelled(shouldCancel) {
  if (shouldCancel?.()) throw new CancelledError();
}

async function writeContent({ engine, item, materialize, sourceRoot, label }) {
  const blob = await materialize(item.node);
  const start = item.sliceStart ?? 0;
  const end = start + item.length;
  if (blob.size !== item.size) {
    throw new Error(`${label} changed size while the backup was being written.`);
  }
  for (let offset = start; offset < end; offset += COPY_CHUNK) {
    const sliceEnd = Math.min(offset + COPY_CHUNK, end);
    const buffer = await blob.slice(offset, sliceEnd).arrayBuffer();
    if (buffer.byteLength !== sliceEnd - offset) {
      throw new Error(`${label} could not be read completely.`);
    }
    await engine.rpc('chunkWrite', { data: buffer }, [buffer]);
  }
  void sourceRoot;
}

/**
 * Writes every chunk of one plan into `base` (a PXFS mount that only holds the
 * new files until the write is committed).
 */
export async function writePlanChunks({
  plan, idHex, archiveType, engine, base, sourceBase, materialize, shouldCancel, onChunkStart,
}) {
  const cap = plan.chunkCap;
  for (const chunk of plan.rewrites) {
    checkCancelled(shouldCancel);
    const name = chunkName(plan.prefix, chunk.index);
    onChunkStart?.({ name, index: chunk.index, total: chunk.end, chunk });
    const target = typeof base === 'function' ? base(chunk) : base;
    await engine.rpc('chunkBegin', {
      path: `${target}/${name}`,
      id: idHex,
      index: chunk.index,
      archiveType,
      cap,
    });

    let written = 0;
    try {
      for (const item of chunk.items) {
        checkCancelled(shouldCancel);
        if (item.kind === 'copy') {
          await engine.rpc('chunkCopy', {
            source: `${sourceBase}/${chunkName(plan.prefix, item.segment)}`,
            offset: item.offset,
            length: item.length,
          });
        } else {
          await writeContent({ engine, item, materialize, sourceRoot: sourceBase, label: item.path });
        }
        written += item.length;
      }
      const result = await engine.rpc('chunkFinish');
      if (Math.abs((result.size ?? 0) - chunk.end) > 0.5) {
        throw new Error(`${name} was written as ${result.size} bytes instead of ${chunk.end}.`);
      }
    } catch (error) {
      await engine.rpc('chunkAbort').catch(() => {});
      throw error;
    }
  }
}

/**
 * Opens an existing index (or starts an empty one) and returns its identity.
 * The index stays open until applyIndex()/closeIndex() so the archive id can
 * be used for the chunk headers.
 */
export async function beginIndex({ engine, open, create }) {
  return await engine.rpc('indexBegin', { open: open ?? null, create: create ?? null });
}

/** Applies the planned index operations, rebuilds the directory list and saves. */
export async function applyIndex({ plan, engine, saveTo, dirs, archive2Size }) {
  const ops = plan?.indexOps ?? { removals: [], renames: [], updates: [], additions: [] };
  return await engine.rpc('indexApply', {
    remove: ops.removals,
    rename: ops.renames,
    update: ops.updates,
    add: ops.additions,
    dirs,
    archive2Size: archive2Size ?? null,
    saveTo,
  });
}

export async function closeIndex(engine) {
  await engine.rpc('indexClose').catch(() => {});
}

/** Estimated time in milliseconds for a plan, from a measured throughput. */
export function estimatePlan(plan, throughput) {
  const perChunk = plan.totals;
  const work = perChunk.copyBytes * 2 + perChunk.writeBytes + perChunk.chunkBytes * 2;
  const rate = throughput > 0 ? throughput : 30 * 1024 * 1024;
  return Math.max(1000, (work / rate) * 1000);
}
