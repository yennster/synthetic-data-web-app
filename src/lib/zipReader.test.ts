import { describe, expect, it } from 'vitest';
import { buildZip } from './zip';
import { readZip } from './zipReader';

// `buildZip` writes STORE-method entries; `readZip` accepts STORE and DEFLATE.
// The most useful coverage here is a round-trip: build a zip we control and
// confirm readZip surfaces the same names + bytes back.

describe('readZip', () => {
  it('round-trips a single text entry from buildZip', async () => {
    const zip = await buildZip([{ name: 'hello.txt', data: 'hello world' }]);
    const entries = await readZip(zip);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('hello.txt');
    expect(entries[0].method).toBe('store');
    expect(new TextDecoder().decode(entries[0].data)).toBe('hello world');
  });

  it('round-trips multiple entries with different content types', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const json = JSON.stringify({ a: 1, b: [2, 3] });
    const zip = await buildZip([
      { name: 'frame.png', data: png },
      { name: 'bounding_boxes.labels', data: json },
    ]);
    const entries = await readZip(zip);
    expect(entries).toHaveLength(2);
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
    expect(Array.from(byName['frame.png'].data)).toEqual(Array.from(png));
    expect(JSON.parse(new TextDecoder().decode(byName['bounding_boxes.labels'].data)))
      .toEqual({ a: 1, b: [2, 3] });
  });

  it('preserves byte-for-byte content of a binary blob entry', async () => {
    const bytes = new Uint8Array(1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) & 0xff;
    const zip = await buildZip([
      { name: 'noise.bin', data: new Blob([bytes], { type: 'application/octet-stream' }) },
    ]);
    const [entry] = await readZip(zip);
    expect(entry.name).toBe('noise.bin');
    expect(entry.data.length).toBe(bytes.length);
    expect(Array.from(entry.data)).toEqual(Array.from(bytes));
  });

  it('throws on a buffer with no EOCD signature', async () => {
    const garbage = new Blob([new Uint8Array([1, 2, 3, 4, 5])]);
    await expect(readZip(garbage)).rejects.toThrow(/EOCD not found/);
  });

  it('returns an empty array for a zip with no entries', async () => {
    const zip = await buildZip([]);
    const entries = await readZip(zip);
    expect(entries).toEqual([]);
  });

  it('handles UTF-8 filenames', async () => {
    const zip = await buildZip([{ name: 'résumé_📸.txt', data: 'data' }]);
    const entries = await readZip(zip);
    expect(entries[0].name).toBe('résumé_📸.txt');
  });
});
