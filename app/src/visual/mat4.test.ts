import { describe, expect, it } from 'vitest';
import { lookAt, multiply, perspective, transformPoint, viewProj } from './mat4';
import type { Vec3 } from './camera3d';

const I = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

describe('multiply', () => {
  it('identity is neutral', () => {
    const m = perspective(1, 1.5, 0.1, 50);
    expect(Array.from(multiply(I, m))).toEqual(Array.from(m));
    expect(Array.from(multiply(m, I))).toEqual(Array.from(m));
  });
});

describe('perspective', () => {
  it('maps near plane to z=0 and far to z=1 in NDC', () => {
    const p = perspective(Math.PI / 2, 1, 1, 100);
    const near = transformPoint(p, [0, 0, -1]); // -near along -Z
    const far = transformPoint(p, [0, 0, -100]);
    expect(near[2] / near[3]).toBeCloseTo(0, 4);
    expect(far[2] / far[3]).toBeCloseTo(1, 4);
  });
});

describe('lookAt', () => {
  it('places the eye at the clip origin (w-divided)', () => {
    const eye: Vec3 = [0, 0, 5];
    const v = lookAt(eye, [0, 0, 0], [0, 1, 0]);
    const at = transformPoint(v, eye);
    expect([at[0], at[1], at[2]]).toEqual([0, 0, 0]);
  });

  it('looks down -Z: target lands ahead (negative view z)', () => {
    const v = lookAt([0, 0, 5], [0, 0, 0], [0, 1, 0]);
    const t = transformPoint(v, [0, 0, 0]);
    expect(t[2]).toBeLessThan(0);
  });
});

describe('viewProj', () => {
  it('projects the look target near screen center', () => {
    const m = viewProj([0, 0, 6], [0, 0, 0], 0.9, 1);
    const c = transformPoint(m, [0, 0, 0]);
    expect(c[0] / c[3]).toBeCloseTo(0, 4);
    expect(c[1] / c[3]).toBeCloseTo(0, 4);
    expect(c[3]).toBeGreaterThan(0); // in front of the camera
  });
});
