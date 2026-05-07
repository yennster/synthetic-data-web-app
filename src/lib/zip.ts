/**
 * Minimal ZIP writer for browser use. Uses the STORE method (no compression),
 * which is fine for PNGs (already compressed) and small JSON sidecars. Avoids
 * pulling in a heavy zip dependency for what is fundamentally a "concatenate
 * blobs with headers" operation.
 *
 * Reference: PKWARE APPNOTE.TXT v6.3.x — Local file header, central directory,
 * EOCD record. Multi-byte fields are little-endian.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export type ZipEntry = { name: string; data: Uint8Array | Blob | string };

async function entryBytes(e: ZipEntry): Promise<Uint8Array> {
  if (typeof e.data === 'string') return new TextEncoder().encode(e.data);
  if (e.data instanceof Blob) return new Uint8Array(await e.data.arrayBuffer());
  return e.data;
}

/**
 * Build a ZIP blob from entries. All entries are stored uncompressed.
 */
export async function buildZip(entries: ZipEntry[]): Promise<Blob> {
  const enc = new TextEncoder();
  const localChunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];

  let offset = 0;
  for (const entry of entries) {
    const nameBytes = enc.encode(entry.name);
    const data = await entryBytes(entry);
    const crc = crc32(data);
    const size = data.length;

    // Local file header (30 bytes + name)
    const lfh = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(lfh.buffer);
    dv.setUint32(0, 0x04034b50, true); // signature
    dv.setUint16(4, 20, true); // version
    dv.setUint16(6, 0, true); // flags
    dv.setUint16(8, 0, true); // method (STORE)
    dv.setUint16(10, 0, true); // mod time
    dv.setUint16(12, 0, true); // mod date
    dv.setUint32(14, crc, true);
    dv.setUint32(18, size, true);
    dv.setUint32(22, size, true);
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true); // extra length
    lfh.set(nameBytes, 30);
    localChunks.push(lfh, data);

    // Central directory entry (46 bytes + name)
    const cdh = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(cdh.buffer);
    cdv.setUint32(0, 0x02014b50, true);
    cdv.setUint16(4, 20, true); // version made by
    cdv.setUint16(6, 20, true); // version needed
    cdv.setUint16(8, 0, true); // flags
    cdv.setUint16(10, 0, true); // method
    cdv.setUint16(12, 0, true); // time
    cdv.setUint16(14, 0, true); // date
    cdv.setUint32(16, crc, true);
    cdv.setUint32(20, size, true);
    cdv.setUint32(24, size, true);
    cdv.setUint16(28, nameBytes.length, true);
    cdv.setUint16(30, 0, true); // extra
    cdv.setUint16(32, 0, true); // comment
    cdv.setUint16(34, 0, true); // disk
    cdv.setUint16(36, 0, true); // int attrs
    cdv.setUint32(38, 0, true); // ext attrs
    cdv.setUint32(42, offset, true); // local header offset
    cdh.set(nameBytes, 46);
    central.push(cdh);

    offset += lfh.length + size;
  }

  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const cdOffset = offset;

  // End of central directory (22 bytes)
  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(4, 0, true); // disk number
  edv.setUint16(6, 0, true); // disk start
  edv.setUint16(8, entries.length, true);
  edv.setUint16(10, entries.length, true);
  edv.setUint32(12, cdSize, true);
  edv.setUint32(16, cdOffset, true);
  edv.setUint16(20, 0, true); // comment len

  const parts: BlobPart[] = [
    ...localChunks.map((u) => u.slice().buffer),
    ...central.map((u) => u.slice().buffer),
    eocd.slice().buffer,
  ];
  return new Blob(parts, { type: 'application/zip' });
}
