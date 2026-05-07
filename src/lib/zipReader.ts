/**
 * Minimal in-browser ZIP reader. Supports STORE (no compression) and DEFLATE
 * (via the platform's DecompressionStream). Used to unpack the Edge Impulse
 * WebAssembly deployment zip downloaded from the Studio API so we can extract
 * the `.js` and `.wasm` files and feed them to the model loader.
 *
 * Reference: PKWARE APPNOTE.TXT — End-of-central-directory at the end of the
 * file, followed (when scanned backwards) by the central directory entries.
 * We don't bother with ZIP64; deployment zips are small.
 */

export type ReadEntry = {
  name: string;
  /** Decompressed bytes. */
  data: Uint8Array;
  method: 'store' | 'deflate' | 'unknown';
};

export async function readZip(blob: Blob): Promise<ReadEntry[]> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  // EOCD signature 0x06054b50, scan backwards from end (with up to 65535-byte
  // optional comment after it).
  const maxBack = Math.min(buf.length, 22 + 65535);
  let eocdAt = -1;
  for (let i = buf.length - 22; i >= buf.length - maxBack; i--) {
    if (
      buf[i] === 0x50 &&
      buf[i + 1] === 0x4b &&
      buf[i + 2] === 0x05 &&
      buf[i + 3] === 0x06
    ) {
      eocdAt = i;
      break;
    }
  }
  if (eocdAt < 0) throw new Error('Not a zip: EOCD not found');

  const totalEntries = dv.getUint16(eocdAt + 10, true);
  const cdSize = dv.getUint32(eocdAt + 12, true);
  const cdOffset = dv.getUint32(eocdAt + 16, true);

  const decoder = new TextDecoder();
  const entries: ReadEntry[] = [];

  let p = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) {
      throw new Error('Bad central directory signature');
    }
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const uncompSize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    const name = decoder.decode(buf.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    // Skip directories (entries ending in '/' with no data).
    if (name.endsWith('/') || uncompSize === 0) continue;

    // Local file header at localOffset; data starts after the variable-
    // length name + extra fields recorded there.
    const lhNameLen = dv.getUint16(localOffset + 26, true);
    const lhExtraLen = dv.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + lhNameLen + lhExtraLen;
    const compressed = buf.subarray(dataStart, dataStart + compSize);

    let data: Uint8Array;
    let methodName: ReadEntry['method'];
    if (method === 0) {
      data = new Uint8Array(compressed); // copy out
      methodName = 'store';
    } else if (method === 8) {
      data = await inflate(compressed);
      methodName = 'deflate';
      if (data.length !== uncompSize) {
        // Some zips lie about uncompSize; trust what inflate returned.
      }
    } else {
      throw new Error(`Unsupported compression method ${method} for ${name}`);
    }
    entries.push({ name, data, method: methodName });
  }

  return entries;
}

async function inflate(compressed: Uint8Array): Promise<Uint8Array> {
  // DecompressionStream is on all modern browsers (Chrome 80+, Safari 16.4+,
  // Firefox 113+). EI WebAssembly users are on a current browser anyway.
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('DecompressionStream not supported in this browser');
  }
  // 'deflate-raw' is needed for zip-stored DEFLATE (no zlib header).
  // Make a copy so the underlying buffer is a real ArrayBuffer (not shared).
  const bytes = new Uint8Array(compressed.length);
  bytes.set(compressed);
  const stream = new ReadableStream({
    start(ctrl) {
      ctrl.enqueue(bytes);
      ctrl.close();
    },
  }).pipeThrough(new DecompressionStream('deflate-raw'));
  const out: Uint8Array[] = [];
  const reader = stream.getReader();
  let total = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
    total += value.length;
  }
  const result = new Uint8Array(total);
  let off = 0;
  for (const chunk of out) {
    result.set(chunk, off);
    off += chunk.length;
  }
  return result;
}
