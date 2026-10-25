// Minimal, streaming ZIP reader and writer.
//
// The panel needs to move whole backups in and out of the browser, so nothing
// here buffers a complete archive: entries are streamed from Blobs (which the
// browser can spill to disk) and the output is assembled as a list of Blob
// parts that is only turned into a single Blob at download time.

const CHUNK = 4 * 1024 * 1024;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let value = i;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[i] = value >>> 0;
  }
  return table;
})();

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const EOCD = 0x06054b50;
const ZIP64_EOCD = 0x06064b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EXTRA = 0x0001;
const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
const UTF8_FLAG = 0x0800;

export async function crc32OfBlob(blob, onBytes) {
  let crc = 0xffffffff;
  for (let offset = 0; offset < blob.size; offset += CHUNK) {
    const end = Math.min(offset + CHUNK, blob.size);
    const bytes = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
    for (let i = 0; i < bytes.length; i++) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    onBytes?.(bytes.length);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
  };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function u16(value) {
  const view = new DataView(new ArrayBuffer(2));
  view.setUint16(0, value & 0xffff, true);
  return new Uint8Array(view.buffer);
}

function u32(value) {
  const view = new DataView(new ArrayBuffer(4));
  view.setUint32(0, value >>> 0, true);
  return new Uint8Array(view.buffer);
}

function u64(value) {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(value), true);
  return new Uint8Array(view.buffer);
}

function join(parts) {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Builds a ZIP archive (stored, no compression) from an iterable of entries.
 *
 * @param {{path: string, getBlob: () => Promise<Blob>, mtime?: Date}[]} entries
 * @returns {Promise<{blob: Blob, bytes: number, entries: number}>}
 */
export async function buildZip(entries, { onProgress, shouldCancel } = {}) {
  const parts = [];
  const central = [];
  let offset = 0;
  let produced = 0;
  let count = 0;

  for (const entry of entries) {
    if (shouldCancel?.()) throw new DOMException('Cancelled', 'AbortError');
    const blob = await entry.getBlob();
    const name = encoder.encode(entry.path.replace(/^\/+/, ''));
    const { date, time } = dosDateTime(entry.mtime instanceof Date ? entry.mtime : new Date());
    const size = blob.size;
    const crc = await crc32OfBlob(blob, onBytes => onProgress?.(produced + onBytes));
    const zip64 = size >= MAX32 || offset >= MAX32;

    const extra = zip64 ? join([u16(ZIP64_EXTRA), u16(16), u64(size), u64(size)]) : new Uint8Array(0);
    const header = join([
      u32(LOCAL_HEADER),
      u16(zip64 ? 45 : 20),
      u16(UTF8_FLAG),
      u16(0), // stored
      u16(time),
      u16(date),
      u32(crc),
      u32(zip64 ? MAX32 : size),
      u32(zip64 ? MAX32 : size),
      u16(name.length),
      u16(extra.length),
      name,
      extra,
    ]);

    parts.push(header, blob);
    central.push({
      name, crc, size, offset, zip64, time, date,
    });
    offset += header.length + size;
    produced += size;
    count++;

    onProgress?.(produced);
  }

  const centralParts = [];
  let centralSize = 0;
  for (const entry of central) {
    const needsOffset64 = entry.zip64 || entry.offset >= MAX32;
    const fields = [];
    if (entry.size >= MAX32) {
      fields.push(u64(entry.size), u64(entry.size));
    }
    if (needsOffset64) fields.push(u64(entry.offset));
    const extra = fields.length
      ? join([u16(ZIP64_EXTRA), u16(fields.reduce((sum, field) => sum + field.length, 0)), ...fields])
      : new Uint8Array(0);
    const record = join([
      u32(CENTRAL_HEADER),
      u16(45),
      u16(entry.zip64 ? 45 : 20),
      u16(UTF8_FLAG),
      u16(0),
      u16(entry.time),
      u16(entry.date),
      u32(entry.crc),
      u32(entry.size >= MAX32 ? MAX32 : entry.size),
      u32(entry.size >= MAX32 ? MAX32 : entry.size),
      u16(entry.name.length),
      u16(extra.length),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(needsOffset64 ? MAX32 : entry.offset),
      entry.name,
      extra,
    ]);
    centralParts.push(record);
    centralSize += record.length;
  }

  const centralBytes = join(centralParts);
  parts.push(centralBytes);

  let tail;
  if (count >= MAX16 || centralSize >= MAX32 || offset >= MAX32) {
    const zip64Offset = offset + centralSize;
    tail = join([
      u32(ZIP64_EOCD),
      u64(44),
      u16(45),
      u16(45),
      u32(0),
      u32(0),
      u64(count),
      u64(count),
      u64(centralSize),
      u64(offset),
      u32(ZIP64_LOCATOR),
      u32(0),
      u64(zip64Offset),
      u32(1),
      u32(EOCD),
      u16(0),
      u16(0),
      u16(MAX16),
      u16(MAX16),
      u32(MAX32),
      u32(MAX32),
      u16(0),
    ]);
  } else {
    tail = join([
      u32(EOCD),
      u16(0),
      u16(0),
      u16(count),
      u16(count),
      u32(centralSize),
      u32(offset),
      u16(0),
    ]);
  }
  parts.push(tail);

  return {
    blob: new Blob(parts, { type: 'application/zip' }),
    bytes: offset + centralSize + tail.length,
    entries: count,
  };
}

async function readBytes(blob, start, length) {
  return new Uint8Array(await blob.slice(start, start + length).arrayBuffer());
}

function findEocd(bytes) {
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
      return i;
    }
  }
  return -1;
}

function parseZip64Extra(extra, needs) {
  let offset = 0;
  while (offset + 4 <= extra.length) {
    const id = extra[offset] | (extra[offset + 1] << 8);
    const size = extra[offset + 2] | (extra[offset + 3] << 8);
    const body = extra.subarray(offset + 4, offset + 4 + size);
    offset += 4 + size;
    if (id !== ZIP64_EXTRA) continue;
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    let cursor = 0;
    const result = {};
    for (const key of needs) {
      if (key === 'size' && cursor + 8 <= body.length) {
        result.size = Number(view.getBigUint64(cursor, true));
        cursor += 8;
      }
      if (key === 'csize' && cursor + 8 <= body.length) {
        result.csize = Number(view.getBigUint64(cursor, true));
        cursor += 8;
      }
      if (key === 'offset' && cursor + 8 <= body.length) {
        result.offset = Number(view.getBigUint64(cursor, true));
        cursor += 8;
      }
    }
    return result;
  }
  return {};
}

/**
 * Reads the central directory of a ZIP file. Entry contents are not loaded;
 * call `getBlob()` on an entry to decompress it on demand.
 */
export async function readZip(file, { onProgress } = {}) {
  const tailLength = Math.min(file.size, 0xffff + 22 + 20);
  const tail = await readBytes(file, file.size - tailLength, tailLength);
  const eocdIndex = findEocd(tail);
  if (eocdIndex < 0) throw new Error('Not a ZIP archive (no end-of-central-directory record).');

  const eocd = new DataView(tail.buffer, tail.byteOffset + eocdIndex, 22);
  let total = eocd.getUint16(10, true);
  let centralSize = eocd.getUint32(12, true);
  let centralOffset = eocd.getUint32(16, true);

  if (total === MAX16 || centralSize === MAX32 || centralOffset === MAX32) {
    const locatorIndex = eocdIndex - 20;
    if (locatorIndex >= 0 && new DataView(tail.buffer, tail.byteOffset + locatorIndex, 4).getUint32(0, true) === ZIP64_LOCATOR) {
      const locator = new DataView(tail.buffer, tail.byteOffset + locatorIndex + 4, 16);
      const zip64Offset = Number(locator.getBigUint64(8, true));
      const record = await readBytes(file, zip64Offset, 56);
      const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
      if (view.getUint32(0, true) !== ZIP64_EOCD) throw new Error('Corrupt ZIP64 end-of-central-directory record.');
      total = Number(view.getBigUint64(32, true));
      centralSize = Number(view.getBigUint64(40, true));
      centralOffset = Number(view.getBigUint64(48, true));
    }
  }

  const directory = await readBytes(file, centralOffset, centralSize);
  const view = new DataView(directory.buffer, directory.byteOffset, directory.byteLength);
  const entries = [];
  let cursor = 0;
  for (let i = 0; i < total && cursor + 46 <= directory.length; i++) {
    if (view.getUint32(cursor, true) !== CENTRAL_HEADER) throw new Error('Corrupt ZIP central directory.');
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const time = view.getUint16(cursor + 12, true);
    const date = view.getUint16(cursor + 14, true);
    const crc = view.getUint32(cursor + 16, true);
    let csize = view.getUint32(cursor + 20, true);
    let size = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const external = view.getUint32(cursor + 38, true);
    let offset = view.getUint32(cursor + 42, true);
    const nameStart = cursor + 46;
    const name = decoder.decode(directory.subarray(nameStart, nameStart + nameLength));
    const extra = directory.subarray(nameStart + nameLength, nameStart + nameLength + extraLength);

    const needs = [];
    if (size === MAX32) needs.push('size');
    if (csize === MAX32) needs.push('csize');
    if (offset === MAX32) needs.push('offset');
    if (needs.length) {
      const extraValues = parseZip64Extra(extra, needs);
      if (extraValues.size !== undefined) size = extraValues.size;
      if (extraValues.csize !== undefined) csize = extraValues.csize;
      if (extraValues.offset !== undefined) offset = extraValues.offset;
    }

    cursor = nameStart + nameLength + extraLength + commentLength;
    const isDir = name.endsWith('/') || (external & 0x10) !== 0;
    if (flags & 1) throw new Error(`"${name}" is encrypted, which this tool cannot open.`);

    let dataStart = 0;
    let cached = null;
    entries.push({
      path: name.replace(/\/+$/, ''),
      isDir,
      size,
      crc,
      method,
      mtime: new Date(1980 + ((date >> 9) & 0x7f), ((date >> 5) & 0x0f) - 1, date & 0x1f,
        (time >> 11) & 0x1f, (time >> 5) & 0x3f, (time & 0x1f) * 2),
      async getBlob() {
        if (cached) return cached;
        if (isDir) return new Blob([]);
        if (!dataStart) {
          const header = await readBytes(file, offset, 30);
          const local = new DataView(header.buffer, header.byteOffset, header.byteLength);
          if (local.getUint32(0, true) !== LOCAL_HEADER) throw new Error('Corrupt ZIP local header.');
          dataStart = offset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
        }
        const raw = file.slice(dataStart, dataStart + csize);
        if (method === 0) {
          cached = raw;
          return cached;
        }
        if (method !== 8) throw new Error(`"${name}" uses unsupported compression method ${method}.`);
        const stream = raw.stream().pipeThrough(new DecompressionStream('deflate-raw'));
        cached = await new Response(stream).blob();
        return cached;
      },
    });
    onProgress?.(i + 1, total);
  }

  return { entries, total };
}
