import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildFileName,
  uploadCaptures,
  uploadImage,
  uploadSample,
} from './edgeImpulse';
import type { Capture, EdgeImpulseConfig } from '../store/useStore';

const baseCfg: EdgeImpulseConfig = {
  apiKey: 'ei_test',
  hmacKey: '',
  category: 'training',
  label: 'idle',
  device: 'unit-test',
};

describe('buildFileName', () => {
  it('sanitises the label and adds an ISO timestamp + .json extension', () => {
    const name = buildFileName('my label!');
    expect(name).toMatch(/^my_label_\.\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d+\.json$/);
  });

  it('falls back to "sample" for empty input', () => {
    expect(buildFileName('')).toMatch(/^sample\./);
  });
});

describe('uploadSample', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => 'ok',
    }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('refuses to send when there are no samples', async () => {
    const res = await uploadSample(baseCfg, [], 100, 'foo.json');
    expect(res.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses to send when the API key is missing', async () => {
    const res = await uploadSample(
      { ...baseCfg, apiKey: '' },
      [{ t: 0, ax: 0, ay: 0, az: 9.81 }],
      100,
      'foo.json',
    );
    expect(res.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends an unsigned payload with alg "none" when no HMAC key is set', async () => {
    await uploadSample(
      baseCfg,
      [
        { t: 0, ax: 0, ay: 0, az: 9.81 },
        { t: 10, ax: 0.1, ay: 0, az: 9.7 },
      ],
      100,
      'foo.json',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/training/data');
    const body = JSON.parse(init.body);
    expect(body.protected.alg).toBe('none');
    // Empty signature is 64 zeros.
    expect(body.signature).toBe('0'.repeat(64));
    expect(body.payload.interval_ms).toBe(10); // 1000/100
    expect(body.payload.values).toEqual([
      [0, 0, 9.81],
      [0.1, 0, 9.7],
    ]);
    expect(init.headers['x-api-key']).toBe('ei_test');
    expect(init.headers['x-label']).toBe('idle');
  });

  it('signs the payload with HMAC-SHA256 when a key is provided', async () => {
    await uploadSample(
      { ...baseCfg, hmacKey: 'sekret' },
      [{ t: 0, ax: 0, ay: 0, az: 9.81 }],
      100,
      'foo.json',
    );
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.protected.alg).toBe('HS256');
    expect(body.signature).toMatch(/^[a-f0-9]{64}$/); // 64 hex chars
    expect(body.signature).not.toBe('0'.repeat(64));
  });

  it('routes to /api/testing/data when category is testing', async () => {
    await uploadSample(
      { ...baseCfg, category: 'testing' },
      [{ t: 0, ax: 0, ay: 0, az: 9.81 }],
      100,
      'foo.json',
    );
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/testing/data');
  });
});

describe('uploadImage', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => 'ok',
    }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('sends multipart with the file and label header', async () => {
    const blob = new Blob(['fake-png'], { type: 'image/png' });
    await uploadImage(baseCfg, blob, 'frame.png', 'sphere', null);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/training/files');
    expect(init.method).toBe('POST');
    expect(init.headers['x-label']).toBe('sphere');
    expect(init.headers['x-bounding-boxes']).toBeUndefined();
    expect(init.body).toBeInstanceOf(FormData);
  });

  it('attaches bounding boxes when provided', async () => {
    const blob = new Blob([''], { type: 'image/png' });
    const boxes = [
      { label: 'cube', x: 0, y: 0, width: 50, height: 50 },
    ];
    await uploadImage(baseCfg, blob, 'frame.png', 'cube', boxes);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.headers['x-bounding-boxes'])).toEqual(boxes);
  });
});

describe('uploadCaptures', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => 'ok',
    }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  function makeCapture(overrides: Partial<Capture> = {}): Capture {
    return {
      id: 'cap-' + Math.random().toString(36).slice(2, 8),
      filename: 'a.png',
      blob: new Blob(['x'], { type: 'image/png' }),
      boxes: [],
      label: '',
      width: 64,
      height: 64,
      ts: 0,
      ...overrides,
    };
  }

  it('uploads each capture and reports done count', async () => {
    const result = await uploadCaptures(
      baseCfg,
      [makeCapture(), makeCapture(), makeCapture()],
      'normal',
      false,
    );
    expect(result.done).toBe(3);
    expect(result.failed).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('reports failures from the server', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'unauthorized' });
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, text: async () => 'ok' });
    const result = await uploadCaptures(
      baseCfg,
      [makeCapture(), makeCapture()],
      'x',
      false,
    );
    expect(result.failed).toBe(1);
    expect(result.done).toBe(1);
    expect(result.lastError).toContain('401');
  });

  it('only attaches boxes when includeBoxes is true', async () => {
    const cap = makeCapture({
      boxes: [{ label: 'cube', x: 1, y: 2, width: 3, height: 4 }],
    });
    await uploadCaptures(baseCfg, [cap], 'x', false);
    let [, init] = fetchMock.mock.calls[0];
    expect(init.headers['x-bounding-boxes']).toBeUndefined();

    fetchMock.mockClear();
    await uploadCaptures(baseCfg, [cap], 'x', true);
    [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.headers['x-bounding-boxes'])).toEqual(cap.boxes);
  });
});
