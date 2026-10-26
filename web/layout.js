// Archive layout and write planning.
//
// A PS3 data archive is a plain concatenation of the contents of its index
// entries: there are no per-file offsets. archive_find_file() walks the index
// and advances through the data chunks, so the position of every file is
// implied by the order and sizes of the entries before it. Chunks after the
// first one start with a 0x50 byte header and the rest of the chunk is data;
// a file that does not fit continues at offset 0x50 of the next chunk.
//
// That makes three kinds of update cheap and one expensive:
//
//   rename / unlink    index only, no data chunk is touched
//   append             only the last chunk is rewritten (or a new chunk is
//                      started when the last one is exactly full)
//   replace (same size) only the chunks that hold the file are rewritten
//   erase / resize     every chunk from the start of the changed file to the
//                      end of the archive has to be rewritten, because all
//                      following files move.
//
// This module computes the layout of an existing archive and turns the working
// copy into a plan that touches as few chunks as possible.

export const CHUNK_HEADER = 0x50;
export const CHUNK_CAP = 0xFFFFFE00;
export const TOMBSTONE_PREFIX = '/dev_hdd0/.ps3xport-unlinked/';

export function chunkName(prefix, index) {
  return `${prefix}_${String(index).padStart(2, '0')}.dat`;
}

export function chunkPattern(prefix) {
  return new RegExp(`^${prefix}_(\\d+)\\.dat$`, 'i');
}

export function isTombstone(path) {
  return String(path).startsWith(TOMBSTONE_PREFIX);
}

export function tombstonePath(index) {
  return `${TOMBSTONE_PREFIX}${index}`;
}

/**
 * Computes where every index entry lives.
 *
 * `files` must be in index order. `chunkSizes` are the actual file sizes on
 * disk, which is what the core uses to move between chunks.
 */
export function layoutArchive(files, chunkSizes) {
  const entries = [];
  const usage = new Array(chunkSizes.length).fill(0);
  const usedEnds = new Array(chunkSizes.length).fill(CHUNK_HEADER);
  let segment = 0;
  let position = CHUNK_HEADER;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (segment >= chunkSizes.length && file.size > 0) {
      throw new Error(`The index describes more data than ${chunkSizes.length} chunk(s) contain.`);
    }

    const spans = [];
    let remaining = file.size;
    let seg = segment;
    let offset = position;
    while (remaining > 0) {
      if (seg >= chunkSizes.length) {
        throw new Error(`"${file.path}" reaches past the last data chunk.`);
      }
      const capacity = chunkSizes[seg] - offset;
      if (capacity <= 0) {
        seg++;
        offset = CHUNK_HEADER;
        continue;
      }
      const length = Math.min(capacity, remaining);
      spans.push({ segment: seg, offset, length });
      usage[seg] += length;
      usedEnds[seg] = Math.max(usedEnds[seg], offset + length);
      remaining -= length;
      seg++;
      offset = CHUNK_HEADER;
    }

    entries.push({
      index: i,
      path: file.path,
      size: file.size,
      mode: file.mode,
      mtime: file.mtime,
      flags: file.flags ?? 0,
      startSegment: segment,
      startOffset: position,
      spans,
      spanCount: spans.length,
      endSegment: spans.length ? spans[spans.length - 1].segment : segment,
    });

    if (position + file.size >= chunkSizes[segment]) {
      position = CHUNK_HEADER + (position + file.size) % chunkSizes[segment];
      segment++;
    } else {
      position += file.size;
    }
  }

  return {
    entries,
    chunkSizes: [...chunkSizes],
    usage,
    usedEnds,
    end: { segment, position },
    chunkCount: chunkSizes.length,
  };
}

function toSeconds(value) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  const time = date.getTime();
  return Number.isFinite(time) ? Math.floor(time / 1000) : Math.floor(Date.now() / 1000);
}

function defaultFileMode(path) {
  return path.startsWith('/dev_flash2') ? 0x8180 : 0x81B6;
}

export function defaultDirMode(path) {
  return path.startsWith('/dev_flash2') ? 0x41FF : 0x41FF;
}

/**
 * Builds the write plan for one archive (archive or archive2).
 *
 * Inputs:
 *   prefix     "archive" or "archive2"
 *   index      [{path,size,mode,mtime,flags}] in index order
 *   layout     result of layoutArchive() for that index
 *   treeFiles  every file in the working copy: [{path, node, size}]
 *   unlink     Set of old paths the user chose to unlink (keep bytes, drop entry)
 *   chunkCap   capacity used for newly written chunks
 */
export function planArchive({
  prefix, index, layout, treeFiles, unlink = new Set(), chunkCap = CHUNK_CAP, forceFull = false, compact = false,
}) {
  const cap = chunkCap;
  const oldCount = layout.chunkCount;
  const chunkSizes = layout.chunkSizes;
  const byPath = new Map(layout.entries.map(entry => [entry.path, entry]));
  const treeByPath = new Map(treeFiles.map(file => [file.path, file]));

  const archiveBySrc = new Map();
  for (const file of treeFiles) {
    const content = file.node?.content;
    if (content?.kind === 'archive' && content.prefix === prefix && !archiveBySrc.has(content.srcPath)) {
      archiveBySrc.set(content.srcPath, file);
    }
  }

  const final = [];
  const covered = new Set();
  const changes = { added: [], modified: [], erased: [], unlinked: [], renamed: [] };
  const indexOps = { removals: [], renames: [], updates: [], additions: [] };
  let structuralEntry = null;
  let structuralOrder = Number.POSITIVE_INFINITY;
  const replaced = []; // items whose data changed but whose size did not

  const sourceOf = file => {
    const content = file.node?.content;
    if (content?.kind === 'archive' && content.prefix === prefix) {
      const source = byPath.get(content.srcPath);
      if (source && file.size === source.size) return { kind: 'old', entry: source };
    }
    return { kind: 'content' };
  };

  layout.entries.forEach((entry, order) => {
    const unlinked = isTombstone(entry.path);
    if (unlinked && !compact) {
      final.push({
        kind: 'tombstone', path: entry.path, finalPath: entry.path, size: entry.size,
        old: entry, data: { kind: 'old', entry }, order,
      });
      covered.add(entry.path);
      return;
    }

    // An explicit unlink wins over an entry at the same path in the working
    // copy: the new file is appended as an addition and the old bytes stay
    // behind a tombstone. This is what the Arkham patcher uses to replace a
    // title update without rewriting the archive tail.
    if (unlink.has(entry.path)) {
      let tombstone = tombstonePath(order);
      for (let suffix = 1; byPath.has(tombstone); suffix++) tombstone = `${TOMBSTONE_PREFIX}${order}-${suffix}`;
      final.push({
        kind: 'tombstone', path: entry.path, finalPath: tombstone, size: entry.size,
        old: entry, data: { kind: 'old', entry }, order,
      });
      changes.unlinked.push({
        path: entry.path, size: entry.size, segments: entry.spans.map(span => span.segment),
      });
      indexOps.renames.push({ from: entry.path, to: tombstone });
      return;
    }

    const direct = treeByPath.get(entry.path);
    if (direct) {
      covered.add(direct.path);
      const data = sourceOf(direct);
      if (data.kind === 'old' && data.entry === entry) {
        final.push({
          kind: 'kept', path: entry.path, finalPath: entry.path, size: entry.size,
          old: entry, node: direct.node, data, order,
        });
        return;
      }
      if (direct.size === entry.size) {
        const item = {
          kind: 'replace', path: entry.path, finalPath: entry.path, size: entry.size,
          old: entry, node: direct.node, data, order,
        };
        final.push(item);
        replaced.push(item);
        changes.modified.push({ path: entry.path, size: entry.size, oldSize: entry.size });
        indexOps.updates.push({
          path: entry.path,
          size: entry.size,
          mode: direct.node.mode ?? entry.mode ?? defaultFileMode(entry.path),
          mtime: toSeconds(direct.node.mtime),
          flags: entry.flags ?? 0,
        });
        return;
      }
      const item = {
        kind: 'resize', path: entry.path, finalPath: entry.path, size: direct.size,
        old: entry, node: direct.node, data, order,
      };
      final.push(item);
      changes.modified.push({ path: entry.path, size: direct.size, oldSize: entry.size });
      indexOps.updates.push({
        path: entry.path,
        size: direct.size,
        mode: direct.node.mode ?? entry.mode ?? defaultFileMode(entry.path),
        mtime: toSeconds(direct.node.mtime),
        flags: entry.flags ?? 0,
      });
      if (order < structuralOrder) {
        structuralOrder = order;
        structuralEntry = entry;
      }
      return;
    }

    const renamed = archiveBySrc.get(entry.path);
    if (renamed) {
      covered.add(renamed.path);
      if (renamed.size === entry.size) {
        final.push({
          kind: 'rename', path: entry.path, finalPath: renamed.path, size: entry.size,
          old: entry, node: renamed.node, data: { kind: 'old', entry }, order,
        });
        changes.renamed.push({ from: entry.path, to: renamed.path, size: entry.size });
        indexOps.renames.push({ from: entry.path, to: renamed.path });
        return;
      }
      const item = {
        kind: 'resize', path: entry.path, finalPath: renamed.path, size: renamed.size,
        old: entry, node: renamed.node, data: { kind: 'content' }, order,
      };
      final.push(item);
      changes.renamed.push({ from: entry.path, to: renamed.path, size: renamed.size });
      indexOps.renames.push({ from: entry.path, to: renamed.path });
      indexOps.updates.push({
        path: renamed.path,
        size: renamed.size,
        mode: renamed.node.mode ?? entry.mode ?? defaultFileMode(renamed.path),
        mtime: toSeconds(renamed.node.mtime),
        flags: entry.flags ?? 0,
      });
      if (order < structuralOrder) {
        structuralOrder = order;
        structuralEntry = entry;
      }
      return;
    }

    changes.erased.push({
      path: entry.path, size: entry.size, segments: entry.spans.map(span => span.segment),
    });
    indexOps.removals.push(entry.path);
    if (order < structuralOrder) {
      structuralOrder = order;
      structuralEntry = entry;
    }
  });

  // New files keep a stable order so a write is reproducible.
  const additions = treeFiles
    .filter(file => !covered.has(file.path))
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  for (const file of additions) {
    final.push({
      kind: 'add', path: file.path, finalPath: file.path, size: file.size,
      old: null, node: file.node, data: sourceOf(file), order: layout.entries.length,
    });
    changes.added.push({ path: file.path, size: file.size });
    indexOps.additions.push({
      path: file.path,
      size: file.size,
      mode: file.node.mode ?? defaultFileMode(file.path),
      mtime: toSeconds(file.node.mtime),
      flags: file.path.startsWith('/dev_flash2') ? 1 : 0,
    });
  }

  if (forceFull) {
    // Writing into a different folder: every chunk has to be produced even if
    // no entry changed, because the destination has no usable chunks yet.
    structuralOrder = 0;
    structuralEntry = layout.entries[0] ?? { startSegment: 0, startOffset: CHUNK_HEADER, spans: [] };
  }

  const rewritten = new Map(); // chunk index -> { index, items, end, isNew }
  const replaceByEntry = new Map(replaced.map(item => [item.old, item]));

  const rangeItems = (segment, from, to) => {
    const located = [];
    for (const entry of layout.entries) {
      for (const span of entry.spans) {
        if (span.segment !== segment) continue;
        const start = Math.max(span.offset, from);
        const end = Math.min(span.offset + span.length, to);
        if (end <= start) continue;
        const replacement = replaceByEntry.get(entry);
        if (replacement) {
          located.push({
            offset: start,
            item: {
              kind: 'content', node: replacement.node, path: replacement.finalPath,
              size: replacement.size, sliceStart: start - span.offset, length: end - start,
            },
          });
        } else {
          located.push({
            offset: start,
            item: { kind: 'copy', segment, offset: start, length: end - start, path: entry.path },
          });
        }
      }
    }
    located.sort((a, b) => a.offset - b.offset);

    const items = [];
    let expected = from;
    for (const { offset, item } of located) {
      if (offset > expected) {
        items.push({ kind: 'copy', segment, offset: expected, length: offset - expected, path: '(padding)' });
      } else if (offset < expected) {
        continue; // an overlapping span cannot happen in a valid archive
      }
      items.push(item);
      expected = offset + item.length;
    }
    if (expected < to) {
      items.push({ kind: 'copy', segment, offset: expected, length: to - expected, path: '(padding)' });
    }
    return items;
  };

  const buildChunk = (index, items, end) => ({
    index,
    items,
    end,
    isNew: index >= oldCount,
  });

  let mode = 'none';
  let startSegment = null;
  const produced = [];

  if (structuralEntry) {
    startSegment = structuralEntry.startSegment;
    mode = startSegment === 0 ? 'full' : 'tail';

    // Everything from the first changed entry onwards is re-emitted.
    const emitted = final.filter(item => item.order >= structuralOrder || item.kind === 'add');

    // A previous file may span into the chunk where the change starts.
    const prefixEnd = structuralEntry.startOffset;

    const builder = createBuilder(startSegment, CHUNK_HEADER, cap, oldCount);
    if (prefixEnd > CHUNK_HEADER) {
      for (const item of rangeItems(startSegment, CHUNK_HEADER, prefixEnd)) builder.emit(item);
    }
    for (const item of emitted) {
      if (item.data.kind === 'old') {
        for (const span of item.data.entry.spans) {
          builder.emit({ kind: 'copy', segment: span.segment, offset: span.offset, length: span.length, path: item.finalPath });
        }
      } else {
        builder.emit({
          kind: 'content', node: item.node, path: item.finalPath, size: item.size, sliceStart: 0, length: item.size,
        });
      }
    }
    produced.push(...builder.finish());

    // Same-size replacements that live before the rewritten tail keep their
    // own chunk, but that chunk still has to be produced again.
    for (const item of replaced) {
      for (const span of item.old.spans) {
        if (span.segment < startSegment) {
          const items = rangeItems(span.segment, CHUNK_HEADER, chunkSizes[span.segment]);
          rewritten.set(span.segment, buildChunk(span.segment, items, chunkSizes[span.segment]));
        }
      }
    }
  } else {
    // Replacements that keep their size only need their own chunks rewritten.
    const dirtyChunks = new Set();
    for (const item of replaced) {
      for (const span of item.old.spans) dirtyChunks.add(span.segment);
    }

    let appendBuilder = null;
    let appendStart = null;
    if (additions.length) {
      const last = oldCount - 1;
      // archive_find_file() derives the next position from the last entry and
      // the chunk size: when the last file ends exactly at a chunk boundary it
      // moves on to a new chunk, otherwise it stays in the same chunk. Follow
      // the same rule so the core reads the new files where we put them.
      const wraps = last < 0 || layout.end.segment > last;
      const usedEnd = last < 0 ? CHUNK_HEADER : (layout.end.segment > last ? CHUNK_HEADER : layout.end.position);
      if (last < 0) {
        appendStart = 0;
        appendBuilder = createBuilder(0, CHUNK_HEADER, cap, oldCount);
      } else if (wraps) {
        appendStart = oldCount;
        appendBuilder = createBuilder(oldCount, CHUNK_HEADER, cap, oldCount);
      } else {
        appendStart = layout.end.segment;
        dirtyChunks.delete(appendStart);
        appendBuilder = createBuilder(appendStart, CHUNK_HEADER, cap, oldCount);
        for (const item of rangeItems(appendStart, CHUNK_HEADER, usedEnd)) appendBuilder.emit(item);
      }
      for (const finalItem of final.filter(item => item.kind === 'add')) {
        if (finalItem.data.kind === 'old') {
          for (const span of finalItem.data.entry.spans) {
            appendBuilder.emit({ kind: 'copy', segment: span.segment, offset: span.offset, length: span.length, path: finalItem.path });
          }
        } else {
          appendBuilder.emit({
            kind: 'content', node: finalItem.node, path: finalItem.path, size: finalItem.size, sliceStart: 0, length: finalItem.size,
          });
        }
      }
      produced.push(...appendBuilder.finish());
      startSegment = appendStart;
    }

    for (const index of [...dirtyChunks].sort((a, b) => a - b)) {
      const items = rangeItems(index, CHUNK_HEADER, chunkSizes[index]);
      rewritten.set(index, buildChunk(index, items, chunkSizes[index]));
    }

    if (produced.length) mode = 'append';
    else if (rewritten.size) mode = 'inplace';
  }

  for (const chunk of produced) rewritten.set(chunk.index, chunk);

  const deleteChunks = [];
  if (structuralEntry) {
    const lastProduced = produced.length ? produced[produced.length - 1].index : startSegment - 1;
    for (let index = lastProduced + 1; index < oldCount; index++) deleteChunks.push(index);
  }

  const rewrites = [...rewritten.values()].sort((a, b) => a.index - b.index);
  let copyBytes = 0;
  let writeBytes = 0;
  let chunkBytes = 0;
  for (const chunk of rewrites) {
    chunkBytes += chunk.end;
    for (const item of chunk.items) {
      if (item.kind === 'copy') copyBytes += item.length;
      else writeBytes += item.length;
    }
    chunk.bytes = chunk.end - CHUNK_HEADER;
  }

  const indexed = rewrites.reduce((sum, chunk) => sum + chunk.items.length, 0);

  return {
    prefix,
    mode,
    structural: Boolean(structuralEntry),
    clearTarget: Boolean(forceFull),
    startSegment,
    rewrites,
    deleteChunks,
    indexOps,
    changes,
    totals: {
      copyBytes,
      writeBytes,
      chunkBytes,
      indexItems: indexed,
      chunkCount: rewrites.length,
      deletedChunks: deleteChunks.length,
    },
    layout,
    chunkCap: cap,
  };
}

function createBuilder(startIndex, startOffset, cap, oldCount) {
  const chunks = [];
  let current = null;
  let nextIndex = startIndex;
  let first = true;

  const open = (index, offset) => {
    current = { index, items: [], end: offset, isNew: index >= oldCount };
    chunks.push(current);
  };

  const emit = item => {
    let remaining = item.length;
    let slice = item.sliceStart ?? 0;
    while (remaining > 0) {
      if (!current) {
        if (first) {
          open(nextIndex, startOffset);
          first = false;
        } else {
          open(nextIndex, CHUNK_HEADER);
        }
        nextIndex = current.index + 1;
      }
      const room = cap - current.end;
      const take = Math.min(room, remaining);
      if (take <= 0) {
        current = null;
        continue;
      }
      if (item.kind === 'copy') {
        current.items.push({
          kind: 'copy', segment: item.segment, offset: item.offset + (item.length - remaining),
          length: take, path: item.path,
        });
      } else {
        current.items.push({
          kind: 'content', node: item.node, path: item.path, size: item.size,
          sliceStart: slice, length: take,
        });
      }
      current.end += take;
      remaining -= take;
      slice += take;
      if (current.end >= cap) current = null;
    }
  };

  const finish = () => chunks.filter(chunk => chunk.end > CHUNK_HEADER || chunk.items.length > 0);

  return { emit, finish };
}

/** Total bytes the plan will read from the device and write to the device. */
export function planTotals(plan) {
  const { copyBytes, writeBytes, chunkBytes } = plan.totals;
  return {
    readBytes: copyBytes,
    writeBytes,
    chunkBytes,
    bytes: copyBytes + writeBytes,
  };
}

/**
 * Approximates where pending additions will land, for file properties before
 * a write. Mirrors the append path of planArchive().
 */
export function projectAdditions(layout, additions, chunkCap = CHUNK_CAP) {
  const placements = new Map();
  const cap = chunkCap;
  let segment;
  let position;

  if (layout.chunkCount === 0) {
    segment = 0;
    position = CHUNK_HEADER;
  } else if (layout.end.segment >= layout.chunkCount) {
    segment = layout.chunkCount;
    position = CHUNK_HEADER;
  } else {
    segment = layout.end.segment;
    position = layout.end.position;
  }

  for (const file of additions) {
    const start = { segment, offset: position };
    let remaining = file.size;
    let seg = segment;
    let offset = position;
    const spans = [];
    while (remaining > 0) {
      const room = cap - offset;
      if (room <= 0) {
        seg++;
        offset = CHUNK_HEADER;
        if (seg >= layout.chunkCount) {
          // A brand new chunk always has room.
        }
        continue;
      }
      const length = Math.min(room, remaining);
      spans.push({ segment: seg, offset, length });
      remaining -= length;
      seg++;
      offset = CHUNK_HEADER;
    }
    placements.set(file.path, { start, spans, end: { segment: seg, position: offset } });
    segment = seg;
    position = offset;
  }

  return placements;
}

/** Splits a layout region into chunk buckets, used for folder properties. */
export function chunkMembership(entries, filter) {
  const buckets = new Map();
  let bytes = 0;
  for (const entry of entries) {
    if (filter && !filter(entry.path)) continue;
    for (const span of entry.spans) {
      let bucket = buckets.get(span.segment);
      if (!bucket) {
        bucket = { index: span.segment, bytes: 0, files: new Set() };
        buckets.set(span.segment, bucket);
      }
      bucket.bytes += span.length;
      bucket.files.add(entry.path);
      bytes += span.length;
    }
  }
  return { buckets: [...buckets.values()].sort((a, b) => a.index - b.index), bytes };
}
