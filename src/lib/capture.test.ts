import { describe, expect, it } from 'vitest';
import {
  buildBoundingBoxLabelsFile,
  makeFilename,
} from './capture';
import type { Capture } from '../store/useStore';

describe('makeFilename', () => {
  it('returns a sanitised, indexed name with png extension', () => {
    const name = makeFilename('my label!', 7);
    expect(name).toMatch(/^my_label_\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d+\.0007\.png$/);
  });

  it('zero-pads the index to 4 digits', () => {
    expect(makeFilename('x', 0)).toContain('.0000.png');
    expect(makeFilename('x', 9999)).toContain('.9999.png');
  });

  it('falls back to "capture" for empty prefixes', () => {
    expect(makeFilename('', 1)).toMatch(/^capture\./);
  });

  it('respects a custom extension', () => {
    expect(makeFilename('label', 3, 'jpg')).toMatch(/\.0003\.jpg$/);
  });
});

describe('buildBoundingBoxLabelsFile', () => {
  const blob = new Blob(['x'], { type: 'image/png' });
  const cap = (filename: string, boxes: Capture['boxes']): Capture => ({
    id: 'id-' + filename,
    filename,
    blob,
    boxes,
    label: '',
    width: 640,
    height: 480,
    ts: 0,
  });

  it('produces the Edge Impulse sidecar shape', () => {
    const json = buildBoundingBoxLabelsFile([
      cap('a.png', [{ label: 'cube', x: 1, y: 2, width: 3, height: 4 }]),
    ]);
    const parsed = JSON.parse(json);
    expect(parsed.version).toBe(1);
    expect(parsed.type).toBe('bounding-box-labels');
    expect(parsed.boundingBoxes['a.png']).toEqual([
      { label: 'cube', x: 1, y: 2, width: 3, height: 4 },
    ]);
  });

  it('skips captures with no boxes', () => {
    const json = buildBoundingBoxLabelsFile([
      cap('a.png', []),
      cap('b.png', [{ label: 'sphere', x: 0, y: 0, width: 10, height: 10 }]),
    ]);
    const parsed = JSON.parse(json);
    expect(parsed.boundingBoxes['a.png']).toBeUndefined();
    expect(parsed.boundingBoxes['b.png']).toBeDefined();
  });

  it('emits an empty mapping when there are no labelled captures', () => {
    const json = buildBoundingBoxLabelsFile([]);
    const parsed = JSON.parse(json);
    expect(parsed.boundingBoxes).toEqual({});
  });
});

