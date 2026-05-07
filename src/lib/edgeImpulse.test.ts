import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildDataAcquisitionPayload,
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

describe('buildDataAcquisitionPayload', () => {
  it('builds Edge Impulse JSON without requiring an API key', async () => {
    const body = await buildDataAcquisitionPayload(
      { device: 'unit-test', hmacKey: '' },
      [{ t: 0, ax: 1, ay: 2, az: 3, gx: 4, gy: 5, gz: 6 }],
      50,
    );

    expect(body.protected.alg).toBe('none');
    expect(body.payload.device_name).toBe('unit-test');
    expect(body.payload.interval_ms).toBe(20);
    expect(body.payload.values).toEqual([[1, 2, 3, 4, 5, 6]]);
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
      [{ t: 0, ax: 0, ay: 0, az: 9.81, gx: 0, gy: 0, gz: 0 }],
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
        { t: 0, ax: 0, ay: 0, az: 9.81, gx: 0, gy: 0, gz: 0 },
        { t: 10, ax: 0.1, ay: 0, az: 9.7, gx: 0.01, gy: 0, gz: -0.01 },
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
      [0, 0, 9.81, 0, 0, 0],
      [0.1, 0, 9.7, 0.01, 0, -0.01],
    ]);
    expect(body.payload.sensors.map((s: { name: string }) => s.name)).toEqual([
      'accX',
      'accY',
      'accZ',
      'gyrX',
      'gyrY',
      'gyrZ',
    ]);
    expect(init.headers['x-api-key']).toBe('ei_test');
    expect(init.headers['x-label']).toBe('idle');
  });

  it('signs the payload with HMAC-SHA256 when a key is provided', async () => {
    await uploadSample(
      { ...baseCfg, hmacKey: 'sekret' },
      [{ t: 0, ax: 0, ay: 0, az: 9.81, gx: 0, gy: 0, gz: 0 }],
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
      [{ t: 0, ax: 0, ay: 0, az: 9.81, gx: 0, gy: 0, gz: 0 }],
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

  it('preserves multiple boxes in the Edge Impulse header payload', async () => {
    const blob = new Blob(['fake-png'], { type: 'image/png' });
    const boxes = [
      { label: 'cube', x: 4, y: 8, width: 32, height: 40 },
      { label: 'sphere', x: 100, y: 12, width: 26, height: 28 },
    ];

    await uploadImage(baseCfg, blob, 'frame.png', 'mixed-scene', boxes);

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers['x-label']).toBe('mixed-scene');
    expect(JSON.parse(init.headers['x-bounding-boxes'])).toEqual(boxes);
  });

  it('does not attach the boxes header for an empty boxes array', async () => {
    const blob = new Blob(['fake-png'], { type: 'image/png' });

    await uploadImage(baseCfg, blob, 'frame.png', 'empty-scene', []);

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers['x-bounding-boxes']).toBeUndefined();
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

  it('uploads each detection capture with its own bounding boxes header', async () => {
    const caps = [
      makeCapture({
        filename: 'frame-0001.png',
        boxes: [
          { label: 'cube', x: 10, y: 20, width: 30, height: 40 },
          { label: 'sphere', x: 50, y: 60, width: 70, height: 80 },
        ],
      }),
      makeCapture({
        filename: 'frame-0002.png',
        boxes: [{ label: 'cone', x: 3, y: 4, width: 5, height: 6 }],
      }),
    ];

    const result = await uploadCaptures(baseCfg, caps, 'objects', true);

    expect(result).toEqual({ done: 2, failed: 0, lastError: undefined });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, firstInit] = fetchMock.mock.calls[0];
    const [, secondInit] = fetchMock.mock.calls[1];
    expect(JSON.parse(firstInit.headers['x-bounding-boxes'])).toEqual(
      caps[0].boxes,
    );
    expect(JSON.parse(secondInit.headers['x-bounding-boxes'])).toEqual(
      caps[1].boxes,
    );
  });

  it('omits the boxes header per capture when detection has no visible boxes', async () => {
    const caps = [
      makeCapture({
        filename: 'empty-frame.png',
        boxes: [],
      }),
      makeCapture({
        filename: 'boxed-frame.png',
        boxes: [{ label: 'cube', x: 1, y: 2, width: 3, height: 4 }],
      }),
    ];

    await uploadCaptures(baseCfg, caps, 'objects', true);

    const [, emptyInit] = fetchMock.mock.calls[0];
    const [, boxedInit] = fetchMock.mock.calls[1];
    expect(emptyInit.headers['x-bounding-boxes']).toBeUndefined();
    expect(JSON.parse(boxedInit.headers['x-bounding-boxes'])).toEqual(
      caps[1].boxes,
    );
  });

  it('uses capture labels when present and falls back to the default label', async () => {
    const caps = [
      makeCapture({ filename: 'default-label.png', label: '' }),
      makeCapture({ filename: 'custom-label.png', label: 'anomaly' }),
    ];

    await uploadCaptures(baseCfg, caps, 'normal', false);

    const [, firstInit] = fetchMock.mock.calls[0];
    const [, secondInit] = fetchMock.mock.calls[1];
    expect(firstInit.headers['x-label']).toBe('normal');
    expect(secondInit.headers['x-label']).toBe('anomaly');
  });

  it('routes detection uploads with boxes to the testing files endpoint', async () => {
    const cap = makeCapture({
      boxes: [{ label: 'cube', x: 1, y: 2, width: 3, height: 4 }],
    });

    await uploadCaptures({ ...baseCfg, category: 'testing' }, [cap], 'objects', true);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/testing/files');
    expect(JSON.parse(init.headers['x-bounding-boxes'])).toEqual(cap.boxes);
  });

  it('reports progress before each boxed upload and after the batch finishes', async () => {
    const caps = [
      makeCapture({
        filename: 'frame-0001.png',
        boxes: [{ label: 'cube', x: 1, y: 2, width: 3, height: 4 }],
      }),
      makeCapture({
        filename: 'frame-0002.png',
        boxes: [{ label: 'sphere', x: 5, y: 6, width: 7, height: 8 }],
      }),
    ];
    const onProgress = vi.fn();

    await uploadCaptures(baseCfg, caps, 'objects', true, onProgress);

    expect(onProgress).toHaveBeenNthCalledWith(1, {
      total: 2,
      done: 0,
      failed: 0,
      current: 'frame-0001.png',
    });
    expect(onProgress).toHaveBeenNthCalledWith(2, {
      total: 2,
      done: 1,
      failed: 0,
      current: 'frame-0002.png',
    });
    expect(onProgress).toHaveBeenLastCalledWith({
      total: 2,
      done: 2,
      failed: 0,
    });
  });
});
