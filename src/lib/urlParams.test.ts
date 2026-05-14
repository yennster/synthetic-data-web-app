import { describe, expect, it } from 'vitest';
import { parseUrlParams } from './urlParams';

function parse(qs: string) {
  return parseUrlParams(new URLSearchParams(qs));
}

describe('parseUrlParams — flags', () => {
  it('defaults are all off / empty / gizmos-on', () => {
    const { flags, presets } = parse('');
    expect(flags).toEqual({
      embed: false,
      ui: 'default',
      gizmos: true,
      debug: false,
      perf: false,
      camLog: false,
      bypassAuth: false,
      autoUpload: false,
      clearStore: false,
    });
    expect(presets).toEqual({});
  });

  it('accepts 1/true/yes/on as truthy and 0/false/no/off as falsy', () => {
    for (const v of ['1', 'true', 'yes', 'on']) {
      expect(parse(`embed=${v}`).flags.embed).toBe(true);
    }
    for (const v of ['0', 'false', 'no', 'off']) {
      expect(parse(`embed=${v}`).flags.embed).toBe(false);
    }
  });

  it('ignores junk values for boolean flags', () => {
    expect(parse('embed=banana').flags.embed).toBe(false);
  });

  it('ui=minimal flips the ui flag; other values fall through to default', () => {
    expect(parse('ui=minimal').flags.ui).toBe('minimal');
    expect(parse('ui=default').flags.ui).toBe('default');
    expect(parse('ui=fancy').flags.ui).toBe('default');
  });

  it('gizmos=0 toggles off; anything else stays on (default-on)', () => {
    expect(parse('gizmos=0').flags.gizmos).toBe(false);
    expect(parse('gizmos=1').flags.gizmos).toBe(true);
    expect(parse('').flags.gizmos).toBe(true);
  });
});

describe('parseUrlParams — scene presets', () => {
  it('accepts valid env presets and rejects others', () => {
    expect(parse('env=outdoor').presets.env).toBe('outdoor');
    expect(parse('env=warehouse').presets.env).toBe('warehouse');
    expect(parse('env=mars').presets.env).toBeUndefined();
  });

  it('parses comma-separated object kinds, dropping unknown entries', () => {
    expect(parse('objects=cube,sphere,phone').presets.objects).toEqual([
      'cube',
      'sphere',
      'phone',
    ]);
    expect(parse('objects=cube,brick,can').presets.objects).toEqual([
      'cube',
      'soda_can', // `can` is aliased
    ]);
    expect(parse('objects=garbage').presets.objects).toBeUndefined();
  });

  it('rounds objectCount and rejects negatives / huge values', () => {
    expect(parse('objectCount=12').presets.objectCount).toBe(12);
    expect(parse('objectCount=12.7').presets.objectCount).toBe(13);
    expect(parse('objectCount=-3').presets.objectCount).toBeUndefined();
    expect(parse('objectCount=10000').presets.objectCount).toBeUndefined();
  });

  it('camera + target as 3-tuples', () => {
    expect(parse('camera=4,3,6').presets.camPos).toEqual([4, 3, 6]);
    expect(parse('target=0,0.5,0').presets.camTarget).toEqual([0, 0.5, 0]);
    expect(parse('camera=4,3').presets.camPos).toBeUndefined();
    expect(parse('camera=a,b,c').presets.camPos).toBeUndefined();
  });

  it('resolution accepts WIDTHxHEIGHT', () => {
    expect(parse('resolution=1024x768').presets.resolution).toEqual({
      width: 1024,
      height: 768,
    });
    expect(parse('resolution=1024×768').presets.resolution).toEqual({
      width: 1024,
      height: 768,
    });
    expect(parse('resolution=foo').presets.resolution).toBeUndefined();
    expect(parse('resolution=99999x768').presets.resolution).toBeUndefined();
  });

  it('trajectory + radius + height compose', () => {
    const { presets } = parse('trajectory=circle&radius=4&height=2');
    expect(presets.trajectory).toBe('circle');
    expect(presets.trajectoryRadius).toBe(4);
    expect(presets.trajectoryHeight).toBe(2);
  });

  it('conveyor + conveyorSpeed', () => {
    expect(parse('conveyor=1&conveyorSpeed=0.7').presets).toMatchObject({
      conveyor: true,
      conveyorSpeed: 0.7,
    });
  });

  it('fov stays within plausible bounds', () => {
    expect(parse('fov=60').presets.fov).toBe(60);
    expect(parse('fov=200').presets.fov).toBeUndefined();
    expect(parse('fov=-5').presets.fov).toBeUndefined();
  });

  it('lightIntensity stays within [0, 10]', () => {
    expect(parse('lightIntensity=1.5').presets.lightIntensity).toBe(1.5);
    expect(parse('lightIntensity=-1').presets.lightIntensity).toBeUndefined();
    expect(parse('lightIntensity=999').presets.lightIntensity).toBeUndefined();
  });
});

describe('parseUrlParams — Edge Impulse presets', () => {
  it('eiLabel keeps user input as-is (trimmed)', () => {
    expect(parse('eiLabel=foo').presets.eiLabel).toBe('foo');
    expect(parse('eiLabel=%20bar%20').presets.eiLabel).toBe('bar');
  });

  it('eiCategory accepts only the three valid buckets', () => {
    expect(parse('eiCategory=training').presets.eiCategory).toBe('training');
    expect(parse('eiCategory=split').presets.eiCategory).toBe('split');
    expect(parse('eiCategory=valid').presets.eiCategory).toBeUndefined();
  });

  it('eiProject parses integer >=1', () => {
    expect(parse('eiProject=12345').presets.eiProject).toBe(12345);
    expect(parse('eiProject=0').presets.eiProject).toBeUndefined();
  });
});

describe('parseUrlParams — realism', () => {
  it('parses each intensity in [0, 1]', () => {
    const { presets } = parse(
      'realism=random&grain=0.5&chromatic=0.3&vignette=0.2&jitter=0.6&jpeg=0.4',
    );
    expect(presets.realismMode).toBe('random');
    expect(presets.realism).toEqual({
      grain: 0.5,
      chromatic: 0.3,
      vignette: 0.2,
      jitter: 0.6,
      jpeg: 0.4,
    });
  });

  it('rejects out-of-range intensities', () => {
    const { presets } = parse('grain=2');
    expect(presets.realism).toBeUndefined();
  });
});

describe('parseUrlParams — robotics + motion', () => {
  it('armPose accepts 6 comma-separated floats', () => {
    expect(parse('armPose=1.57,1.0,0.5,1.57,1.57,0.5').presets.armPose).toEqual([
      1.57, 1.0, 0.5, 1.57, 1.57, 0.5,
    ]);
    expect(parse('armPose=1,2,3').presets.armPose).toBeUndefined();
  });

  it('roverEvent picks from the closed set', () => {
    expect(parse('roverEvent=collision').presets.roverEvent).toBe('collision');
    expect(parse('roverEvent=parking').presets.roverEvent).toBeUndefined();
  });

  it('sampleRate parses integer >= 1', () => {
    expect(parse('sampleRate=200').presets.sampleRate).toBe(200);
    expect(parse('sampleRate=0').presets.sampleRate).toBeUndefined();
  });
});

describe('parseUrlParams — mode aliases', () => {
  it('treats `?mode=arm` as robot + arm sub-mode', () => {
    expect(parse('mode=arm').presets.mode).toBe('robot');
    expect(parse('mode=arm').presets.robotKind).toBe('arm');
  });

  it('treats `?mode=objects` as detection', () => {
    expect(parse('mode=objects').presets.mode).toBe('detection');
  });

  it('parses the explicit ?robot= override even without ?mode=', () => {
    expect(parse('robot=arm').presets.robotKind).toBe('arm');
  });
});

describe('parseUrlParams — composition', () => {
  it('combines a deep-link demo URL into one preset object', () => {
    const { presets, flags } = parse(
      'env=outdoor&objects=cube,sphere&batchCount=20&trajectory=circle&radius=4&height=2&seed=42&embed=1&autoUpload=1',
    );
    expect(presets).toMatchObject({
      env: 'outdoor',
      objects: ['cube', 'sphere'],
      batchCount: 20,
      trajectory: 'circle',
      trajectoryRadius: 4,
      trajectoryHeight: 2,
      seed: 42,
    });
    expect(flags.embed).toBe(true);
    expect(flags.autoUpload).toBe(true);
  });
});
