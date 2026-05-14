import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildDataAcquisitionPayload,
  buildFileName,
  buildInfoLabelsEntry,
  buildInfoLabelsFile,
  buildIngestionMetadata,
  buildRoverDataAcquisitionPayload,
  getEiProjectDataKinds,
  inferIntervalMs,
  normalizeHost,
  resolveBucket,
  uploadCaptures,
  uploadImage,
  uploadRoverSample,
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

async function readMultipartJsonPayload(init: {
  body: FormData;
}): Promise<any> {
  const file = init.body.get('data') as Blob | null;
  expect(file).toBeInstanceOf(Blob);
  return JSON.parse(await file!.text());
}

describe('buildFileName', () => {
  it('sanitises the label and adds an ISO timestamp + .json extension', () => {
    const name = buildFileName('my label!');
    expect(name).toMatch(/^my_label_\.\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d+\.json$/);
  });

  it('falls back to "sample" for empty input', () => {
    expect(buildFileName('')).toMatch(/^sample\./);
  });
});

describe('resolveBucket', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns the input verbatim for explicit training/testing', () => {
    expect(resolveBucket('training')).toBe('training');
    expect(resolveBucket('testing')).toBe('testing');
  });

  it('routes to training when split rolls under 0.8', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    expect(resolveBucket('split')).toBe('training');
  });

  it('routes to testing when split rolls over 0.8', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.95);
    expect(resolveBucket('split')).toBe('testing');
  });

  it('respects the 80/20 ratio over many rolls', () => {
    let n = 0;
    // 80 hits below 0.8, 20 above — exactly 80/20.
    vi.spyOn(Math, 'random').mockImplementation(() => {
      n += 1;
      return (n - 1) / 100;
    });
    let train = 0;
    let test = 0;
    for (let i = 0; i < 100; i++) {
      if (resolveBucket('split') === 'training') train += 1;
      else test += 1;
    }
    expect(train).toBe(80);
    expect(test).toBe(20);
  });
});

describe('buildIngestionMetadata', () => {
  it('always tags samples with the studio source name', () => {
    const meta = JSON.parse(buildIngestionMetadata());
    expect(meta.source).toBe('Synthetic Data Studio');
  });

  it('adds source_url when window.location is available', () => {
    const original = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      location: { origin: 'https://studio.example', pathname: '/app', href: 'https://studio.example/app' },
    };
    try {
      const meta = JSON.parse(buildIngestionMetadata());
      expect(meta.source_url).toBe('https://studio.example/app');
    } finally {
      if (original === undefined) delete (globalThis as { window?: unknown }).window;
      else (globalThis as { window?: unknown }).window = original;
    }
  });

  it('coerces extras to strings and skips undefined / null / empty values', () => {
    const meta = JSON.parse(
      buildIngestionMetadata({
        shape: 'cube',
        sample_rate_hz: 100,
        physics: true,
        empty: '',
        nope: undefined,
        nada: null,
      }),
    );
    expect(meta.shape).toBe('cube');
    expect(meta.sample_rate_hz).toBe('100');
    expect(meta.physics).toBe('true');
    expect(meta.empty).toBeUndefined();
    expect(meta.nope).toBeUndefined();
    expect(meta.nada).toBeUndefined();
  });
});

describe('buildInfoLabelsFile', () => {
  it('writes Edge Impulse info.labels entries with label and metadata', () => {
    const entry = buildInfoLabelsEntry({
      path: 'pick_place_1.json',
      category: 'training',
      label: 'pick_place',
      metadataExtras: {
        mode: 'robot',
        pickup_success: false,
        pickup_failure_reason: 'target_tipped',
      },
    });
    const info = JSON.parse(buildInfoLabelsFile([entry]));
    expect(info.version).toBe(1);
    expect(info.files).toHaveLength(1);
    expect(info.files[0]).toMatchObject({
      path: 'pick_place_1.json',
      category: 'training',
      label: { type: 'label', label: 'pick_place' },
      metadata: {
        source: 'Synthetic Data Studio',
        mode: 'robot',
        pickup_success: 'false',
        pickup_failure_reason: 'target_tipped',
      },
    });
  });
});

describe('inferIntervalMs', () => {
  const sample = (t: number) => ({
    t,
    ax: 0,
    ay: 0,
    az: 0,
    gx: 0,
    gy: 0,
    gz: 0,
  });

  it('falls back to 1000/sampleRateHz when there are fewer than 2 samples', () => {
    expect(inferIntervalMs([], 100)).toBe(10);
    expect(inferIntervalMs([sample(0)], 50)).toBe(20);
  });

  it('uses the per-sample timestamp span when available', () => {
    // 5 samples spanning 64ms → mean interval = 16ms (≈ 60 fps render).
    const samples = [0, 16, 32, 48, 64].map(sample);
    expect(inferIntervalMs(samples, 100)).toBeCloseTo(16, 5);
  });

  it('reports the actual emitted rate even when it differs from requested', () => {
    // The exact case behind the 2 s → 1.2 s bug: user asked for 100 Hz
    // but the sampler emitted at ~60 Hz, so the trace would render
    // 1.67× too short if we trusted the requested rate.
    const samples = [];
    for (let i = 0; i < 60; i++) samples.push(sample(i * 16.667));
    expect(inferIntervalMs(samples, 100)).toBeCloseTo(16.667, 1);
  });

  it('falls back to the requested rate when timestamps are degenerate', () => {
    // All samples carry the same timestamp (e.g. perf.now resolution
    // clamped) — we can't infer anything, so use the requested rate.
    const samples = [sample(0), sample(0), sample(0)];
    expect(inferIntervalMs(samples, 100)).toBe(10);
  });

  it('falls back when the timestamps go backwards', () => {
    const samples = [sample(100), sample(50)];
    expect(inferIntervalMs(samples, 100)).toBe(10);
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

  it('reports the actual sample interval, not the requested rate (the 2s→1.2s bug)', async () => {
    // 122 samples over 2032ms (≈ 60 Hz emission, 100 Hz requested).
    // EI plots `samples * interval_ms`, so a wrong interval here renders
    // a 2 s drop as ~1.2 s in the Studio.
    const N = 122;
    const span = 2032;
    const samples = [];
    for (let i = 0; i < N; i++) {
      samples.push({
        t: (i * span) / (N - 1),
        ax: 0,
        ay: 9.81,
        az: 0,
        gx: 0,
        gy: 0,
        gz: 0,
      });
    }
    const body = await buildDataAcquisitionPayload(
      { device: 'unit-test', hmacKey: '' },
      samples,
      100, // user asked for 100 Hz
    );
    // Reported interval should reflect the *actual* spacing (~16.7 ms),
    // not 1000/100 = 10 ms.
    expect(body.payload.interval_ms).toBeCloseTo(span / (N - 1), 5);
    // Sanity: trace duration EI will render is samples * interval ≈ span.
    expect(body.payload.values.length * body.payload.interval_ms).toBeCloseTo(
      (N * span) / (N - 1),
      0,
    );
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
    expect(url).toContain('/api/training/files');
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.headers['Content-Type']).toBeUndefined();
    const body = await readMultipartJsonPayload(init);
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
    const meta = JSON.parse(init.headers['x-metadata']);
    expect(meta.source).toBe('Synthetic Data Studio');
  });

  it('forwards metadata extras into the x-metadata header', async () => {
    await uploadSample(
      baseCfg,
      [{ t: 0, ax: 0, ay: 0, az: 9.81, gx: 0, gy: 0, gz: 0 }],
      100,
      'foo.json',
      { mode: 'motion', shape: 'cube', sample_rate_hz: 100 },
    );
    const [, init] = fetchMock.mock.calls[0];
    const meta = JSON.parse(init.headers['x-metadata']);
    expect(meta.source).toBe('Synthetic Data Studio');
    expect(meta.mode).toBe('motion');
    expect(meta.shape).toBe('cube');
    expect(meta.sample_rate_hz).toBe('100');
  });

  it('signs the payload with HMAC-SHA256 when a key is provided', async () => {
    await uploadSample(
      { ...baseCfg, hmacKey: 'sekret' },
      [{ t: 0, ax: 0, ay: 0, az: 9.81, gx: 0, gy: 0, gz: 0 }],
      100,
      'foo.json',
    );
    const [, init] = fetchMock.mock.calls[0];
    const body = await readMultipartJsonPayload(init);
    expect(body.protected.alg).toBe('HS256');
    expect(body.signature).toMatch(/^[a-f0-9]{64}$/); // 64 hex chars
    expect(body.signature).not.toBe('0'.repeat(64));
  });

  it('routes to training and tags split_bucket=training when split rolls below 0.8', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    await uploadSample(
      { ...baseCfg, category: 'split' },
      [{ t: 0, ax: 0, ay: 0, az: 9.81, gx: 0, gy: 0, gz: 0 }],
      100,
      'foo.json',
    );
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/training/files');
    const meta = JSON.parse(init.headers['x-metadata']);
    expect(meta.split_bucket).toBe('training');
    vi.unstubAllGlobals();
  });

  it('routes to testing and tags split_bucket=testing when split rolls above 0.8', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.95);
    await uploadSample(
      { ...baseCfg, category: 'split' },
      [{ t: 0, ax: 0, ay: 0, az: 9.81, gx: 0, gy: 0, gz: 0 }],
      100,
      'foo.json',
    );
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/testing/files');
    const meta = JSON.parse(init.headers['x-metadata']);
    expect(meta.split_bucket).toBe('testing');
    vi.restoreAllMocks();
  });

  it('routes to /api/testing/files when category is testing', async () => {
    await uploadSample(
      { ...baseCfg, category: 'testing' },
      [{ t: 0, ax: 0, ay: 0, az: 9.81, gx: 0, gy: 0, gz: 0 }],
      100,
      'foo.json',
    );
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/testing/files');
  });
});

describe('rover fused uploads', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const imu = [
    { t: 0, ax: 0, ay: 0, az: 9.81, gx: 0, gy: 0, gz: 0 },
    { t: 50, ax: 0.1, ay: 0, az: 9.7, gx: 0.01, gy: 0, gz: -0.01 },
  ];
  const lidar = [
    { t: 0, ranges: [1, 2, 3] },
    { t: 50, ranges: [1.1, 2.1, 3.1] },
  ];

  beforeEach(() => {
    fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => 'ok',
    }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('refuses to build an empty fused payload when either stream is missing', async () => {
    await expect(
      buildRoverDataAcquisitionPayload(
        { device: 'unit-test', hmacKey: '' },
        imu,
        [],
        20,
        6,
      ),
    ).rejects.toThrow(/both IMU and lidar/);
    await expect(
      buildRoverDataAcquisitionPayload(
        { device: 'unit-test', hmacKey: '' },
        [],
        lidar,
        20,
        6,
      ),
    ).rejects.toThrow(/both IMU and lidar/);
  });

  it('does not upload fused samples unless both IMU and lidar are present', async () => {
    const missingLidar = await uploadRoverSample(
      baseCfg,
      imu,
      [],
      20,
      6,
      'fused.json',
    );
    const missingImu = await uploadRoverSample(
      baseCfg,
      [],
      lidar,
      20,
      6,
      'fused.json',
    );

    expect(missingLidar.ok).toBe(false);
    expect(missingImu.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('packs IMU and lidar channels together when both streams exist', async () => {
    await uploadRoverSample(baseCfg, imu, lidar, 20, 6, 'fused.json');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const body = await readMultipartJsonPayload(init);
    expect(body.payload.sensors.map((s: { name: string }) => s.name)).toEqual([
      'accX',
      'accY',
      'accZ',
      'gyrX',
      'gyrY',
      'gyrZ',
      'r0',
      'r1',
      'r2',
    ]);
    expect(body.payload.values).toEqual([
      [0, 0, 9.81, 0, 0, 0, 1, 2, 3],
      [0.1, 0, 9.7, 0.01, 0, -0.01, 1.1, 2.1, 3.1],
    ]);
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
    const meta = JSON.parse(init.headers['x-metadata']);
    expect(meta.source).toBe('Synthetic Data Studio');
    expect(init.body).toBeInstanceOf(FormData);
  });

  it('forwards metadata extras into the x-metadata header', async () => {
    const blob = new Blob(['fake-png'], { type: 'image/png' });
    await uploadImage(baseCfg, blob, 'frame.png', 'sphere', null, {
      mode: 'anomaly',
      shape: 'sphere',
    });
    const [, init] = fetchMock.mock.calls[0];
    const meta = JSON.parse(init.headers['x-metadata']);
    expect(meta.source).toBe('Synthetic Data Studio');
    expect(meta.mode).toBe('anomaly');
    expect(meta.shape).toBe('sphere');
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

  it('merges batch metadata extras with per-capture shapes + dimensions', async () => {
    const cap = makeCapture({
      filename: 'frame.png',
      width: 320,
      height: 240,
      shapes: ['cube', 'sphere'],
    });

    await uploadCaptures(baseCfg, [cap], 'mixed', false, undefined, {
      mode: 'detection',
      env_preset: 'studio',
    });

    const [, init] = fetchMock.mock.calls[0];
    const meta = JSON.parse(init.headers['x-metadata']);
    expect(meta.source).toBe('Synthetic Data Studio');
    expect(meta.mode).toBe('detection');
    expect(meta.env_preset).toBe('studio');
    expect(meta.width).toBe('320');
    expect(meta.height).toBe('240');
    expect(meta.shapes).toBe('cube,sphere');
  });

  it('emits asset filenames and labels from the capture snapshot', async () => {
    const cap = makeCapture({
      filename: 'frame.png',
      assetSnapshot: [
        { name: 'wrench.usdz', label: 'wrench' },
        { name: 'bolt.usdz', label: 'bolt' },
      ],
    });

    await uploadCaptures(baseCfg, [cap], 'tools', false);

    const [, init] = fetchMock.mock.calls[0];
    const meta = JSON.parse(init.headers['x-metadata']);
    expect(meta.asset_files).toBe('wrench.usdz,bolt.usdz');
    expect(meta.asset_labels).toBe('wrench,bolt');
    expect(meta.asset_count).toBe('2');
  });

  it('omits asset metadata when the capture has no imported assets', async () => {
    const cap = makeCapture({ filename: 'empty.png' });
    await uploadCaptures(baseCfg, [cap], 'x', false);
    const [, init] = fetchMock.mock.calls[0];
    const meta = JSON.parse(init.headers['x-metadata']);
    expect(meta.asset_files).toBeUndefined();
    expect(meta.asset_labels).toBeUndefined();
    expect(meta.asset_count).toBeUndefined();
  });

  it('omits shapes from metadata when the capture has none', async () => {
    const cap = makeCapture({ filename: 'empty.png' });
    await uploadCaptures(baseCfg, [cap], 'x', false);
    const [, init] = fetchMock.mock.calls[0];
    const meta = JSON.parse(init.headers['x-metadata']);
    expect(meta.shapes).toBeUndefined();
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

describe('getEiProjectDataKinds', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  /** Build a stub that routes by URL substring:
   *   - `/<id>` (no `/raw-data`, no `category=`) → project info
   *   - `/raw-data?category=training`            → training samples
   *   - `/raw-data?category=testing`             → testing samples
   *
   * `samplesByCategory` accepts arbitrary sample objects so individual
   * tests can exercise the structural-signal classifier (intervalMs,
   * thumbnailUrl, etc.) without hand-rolling fetch handlers each time.
   * `projectInfo` is omitted entirely from the response when unset, so
   * the production code's `!r.project` guard correctly falls through
   * to the raw-data path. */
  function stubEi(opts: {
    projectInfo?: Record<string, unknown> | null;
    samplesByCategory?: Record<string, unknown[]>;
  }) {
    fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/raw-data')) {
        const m = url.match(/category=(\w+)/);
        const category = m?.[1] ?? 'training';
        const samples = opts.samplesByCategory?.[category] ?? [];
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          text: async () => JSON.stringify({ success: true, samples }),
        };
      }
      // Project info endpoint.
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () =>
          JSON.stringify(
            opts.projectInfo === null
              ? { success: false, error: 'no project info' }
              : { success: true, project: opts.projectInfo ?? {} },
          ),
      };
    });
    vi.stubGlobal('fetch', fetchMock);
  }

  afterEach(() => vi.unstubAllGlobals());

  it('reports empty when both project info and samples are empty', async () => {
    stubEi({ projectInfo: null });
    const r = await getEiProjectDataKinds('ei_test', 42);
    expect(r).toEqual({
      hasImages: false,
      hasTimeSeries: false,
      totalChecked: 0,
    });
  });

  it('uses isComputerVisionProject from /<id> as the authoritative signal', async () => {
    // The bug we are fixing: an image-typed object-detection project
    // (the user's "Conveyor Belt Cans" project) was getting
    // misclassified as time-series because raw-data filenames don't
    // carry an extension. Project info should short-circuit to image.
    stubEi({
      projectInfo: { isComputerVisionProject: true },
      // Even if raw-data is empty, the project-info short-circuit
      // wins — no second fetch should be needed.
      samplesByCategory: { training: [], testing: [] },
    });
    const r = await getEiProjectDataKinds('ei_test', 42);
    expect(r.hasImages).toBe(true);
    expect(r.hasTimeSeries).toBe(false);
    // Only one fetch — to /<id>. Raw-data should never have been queried.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).not.toContain('/raw-data');
  });

  it('infers image from labelingMethod="bounding-boxes" in project info', async () => {
    stubEi({
      projectInfo: { labelingMethod: 'bounding-boxes' },
    });
    const r = await getEiProjectDataKinds('ei_test', 42);
    expect(r.hasImages).toBe(true);
    expect(r.hasTimeSeries).toBe(false);
  });

  it('infers image from dataAcquisitionType containing "image"', async () => {
    stubEi({
      projectInfo: { dataAcquisitionType: 'image' },
    });
    const r = await getEiProjectDataKinds('ei_test', 42);
    expect(r.hasImages).toBe(true);
  });

  it('infers time-series from dataAcquisitionType="accelerometer"', async () => {
    stubEi({
      projectInfo: { dataAcquisitionType: 'accelerometer' },
    });
    const r = await getEiProjectDataKinds('ei_test', 42);
    expect(r.hasTimeSeries).toBe(true);
    expect(r.hasImages).toBe(false);
  });

  it('falls back to raw-data when project info has no useful flags', async () => {
    stubEi({
      projectInfo: { dataAcquisitionType: 'unknown' },
      samplesByCategory: {
        training: [{ filename: 'a.png' }],
        testing: [],
      },
    });
    const r = await getEiProjectDataKinds('ei_test', 42);
    expect(r.hasImages).toBe(true);
  });

  it('classifies time-series samples by intervalMs > 0', async () => {
    stubEi({
      projectInfo: null,
      samplesByCategory: {
        training: [{ filename: '1.cbor', intervalMs: 10, valuesCount: 2000 }],
        testing: [],
      },
    });
    const r = await getEiProjectDataKinds('ei_test', 42);
    expect(r.hasTimeSeries).toBe(true);
    expect(r.hasImages).toBe(false);
  });

  it('classifies image samples by thumbnailUrl even without an extension', async () => {
    // Regression test for the user's bug: EI stores ingested images
    // under `.cbor` filenames internally. The filename-only classifier
    // misread these as time-series. Thumbnails are the structural
    // signal that survives the storage detail.
    stubEi({
      projectInfo: null,
      samplesByCategory: {
        training: [
          { filename: '1.cbor', thumbnailUrl: 'https://example/thumb.png' },
        ],
        testing: [],
      },
    });
    const r = await getEiProjectDataKinds('ei_test', 42);
    expect(r.hasImages).toBe(true);
    expect(r.hasTimeSeries).toBe(false);
  });

  it('classifies images via explicit chartType="image"', async () => {
    stubEi({
      projectInfo: null,
      samplesByCategory: {
        training: [{ chartType: 'image' }],
        testing: [],
      },
    });
    const r = await getEiProjectDataKinds('ei_test', 42);
    expect(r.hasImages).toBe(true);
  });

  it('still uses filename extension as a last resort', async () => {
    stubEi({
      projectInfo: null,
      samplesByCategory: {
        training: [
          { filename: 'a.png' },
          { filename: 'b.JPG' },
          { filename: 'c.jpeg' },
          { filename: 'd.webp' },
        ],
        testing: [],
      },
    });
    const r = await getEiProjectDataKinds('ei_test', 42);
    expect(r.hasImages).toBe(true);
  });

  it('flags mixed projects when both types appear across categories', async () => {
    stubEi({
      projectInfo: null,
      samplesByCategory: {
        training: [{ filename: 'snap.png' }],
        testing: [{ intervalMs: 10, valuesCount: 2000 }],
      },
    });
    const r = await getEiProjectDataKinds('ei_test', 42);
    expect(r.hasImages).toBe(true);
    expect(r.hasTimeSeries).toBe(true);
  });

  it('short-circuits the testing fetch once both flags are set', async () => {
    stubEi({
      projectInfo: null,
      samplesByCategory: {
        training: [
          { filename: 'snap.png' },
          { intervalMs: 10, valuesCount: 2000 },
        ],
        testing: [{ filename: 'other.png' }],
      },
    });
    await getEiProjectDataKinds('ei_test', 42);
    // /<id> + /raw-data?category=training — no testing fetch.
    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls.some((u) => u.includes('category=training'))).toBe(true);
    expect(urls.some((u) => u.includes('category=testing'))).toBe(false);
  });

  it('skips samples that yield no signal at all', async () => {
    stubEi({
      projectInfo: null,
      samplesByCategory: {
        training: [
          {}, // no fields → null classification, skipped
          { filename: '' }, // empty filename → null, skipped
          { filename: '1.cbor' }, // unrecognized ext → null, skipped
          { filename: 'real.png' }, // image fallback hits
        ],
        testing: [],
      },
    });
    const r = await getEiProjectDataKinds('ei_test', 42);
    expect(r.hasImages).toBe(true);
    expect(r.totalChecked).toBe(1);
  });

  it('sends the API key via x-api-key on every fetch', async () => {
    stubEi({
      projectInfo: null,
      samplesByCategory: {
        training: [{ filename: 'x.png' }],
        testing: [{ filename: 'y.png' }],
      },
    });
    await getEiProjectDataKinds('my-key', 7);
    for (const call of fetchMock.mock.calls) {
      const [, init] = call;
      expect(init.headers['x-api-key']).toBe('my-key');
    }
    // First call is the project info on /<id>, then raw-data per category.
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/7$/);
  });
});

describe('normalizeHost', () => {
  it('prepends https:// when no scheme is supplied (edgeimpulse subdomain)', () => {
    expect(normalizeHost('studio.edgeimpulse.com')).toBe(
      'https://studio.edgeimpulse.com',
    );
  });

  it('preserves an explicit https:// scheme', () => {
    expect(normalizeHost('https://studio.edgeimpulse.com')).toBe(
      'https://studio.edgeimpulse.com',
    );
  });

  it('preserves an explicit http:// scheme for loopback dev backends', () => {
    expect(normalizeHost('http://localhost:4800')).toBe('http://localhost:4800');
    expect(normalizeHost('http://127.0.0.1:4800')).toBe('http://127.0.0.1:4800');
  });

  it('strips trailing slashes', () => {
    expect(normalizeHost('https://studio.edgeimpulse.com/')).toBe(
      'https://studio.edgeimpulse.com',
    );
    expect(normalizeHost('staging.edgeimpulse.com///')).toBe(
      'https://staging.edgeimpulse.com',
    );
  });

  it('rejects untrusted hostnames (anti-phishing allowlist)', () => {
    expect(() => normalizeHost('studio.example.com')).toThrow(/untrusted/);
    expect(() => normalizeHost('https://attacker.example.com')).toThrow(
      /untrusted/,
    );
    expect(() => normalizeHost('edgeimpulse.com.evil.example')).toThrow(
      /untrusted/,
    );
  });

  it('rejects http:// for non-loopback hosts (forces https in production)', () => {
    expect(() => normalizeHost('http://studio.edgeimpulse.com')).toThrow(
      /untrusted/,
    );
  });
});
