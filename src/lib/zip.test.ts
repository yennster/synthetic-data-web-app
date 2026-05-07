import { describe, expect, it } from 'vitest';
import { buildZip } from './zip';

async function readBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

describe('buildZip', () => {
  it('produces a valid PK header and EOCD signature', async () => {
    const zip = await buildZip([{ name: 'a.txt', data: 'hello' }]);
    expect(zip.type).toBe('application/zip');
    const bytes = await readBytes(zip);
    // Local file header at offset 0
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
    expect(bytes[2]).toBe(0x03);
    expect(bytes[3]).toBe(0x04);
    // EOCD signature appears in the last 22 bytes
    const tail = bytes.slice(bytes.length - 22, bytes.length - 18);
    expect(tail[0]).toBe(0x50);
    expect(tail[1]).toBe(0x4b);
    expect(tail[2]).toBe(0x05);
    expect(tail[3]).toBe(0x06);
  });

  it('encodes file names and contents verbatim', async () => {
    const zip = await buildZip([{ name: 'hello.txt', data: 'world' }]);
    const bytes = await readBytes(zip);
    const decoder = new TextDecoder();
    const dump = decoder.decode(bytes);
    expect(dump).toContain('hello.txt');
    expect(dump).toContain('world');
  });

  it('handles multiple entries', async () => {
    const zip = await buildZip([
      { name: 'a.txt', data: 'foo' },
      { name: 'b.txt', data: 'bar' },
    ]);
    const bytes = await readBytes(zip);
    // Two local file headers (PK\x03\x04)
    let count = 0;
    for (let i = 0; i < bytes.length - 3; i++) {
      if (
        bytes[i] === 0x50 &&
        bytes[i + 1] === 0x4b &&
        bytes[i + 2] === 0x03 &&
        bytes[i + 3] === 0x04
      ) {
        count++;
      }
    }
    expect(count).toBe(2);
  });
});
