import { describe, expect, it } from 'vitest';
import { CAMERA_PARAMS, cameraEye, camFromParams, type Cam } from './camera3d';

const base: Cam = { dist: 6, yaw: 0, pitch: 0, fov: 0.9, spin: 0 };

describe('cameraEye', () => {
  it('orbits the origin at the set distance', () => {
    const { eye, target } = cameraEye(base, 0);
    expect(target).toEqual([0, 0, 0]);
    expect(Math.hypot(...eye)).toBeCloseTo(6, 5);
  });

  it('yaw=0 looks down +Z', () => {
    const { eye } = cameraEye(base, 0);
    expect(eye[0]).toBeCloseTo(0, 5);
    expect(eye[2]).toBeCloseTo(6, 5);
  });

  it('quarter-turn yaw swings to +X', () => {
    const { eye } = cameraEye({ ...base, yaw: 0.25 }, 0);
    expect(eye[0]).toBeCloseTo(6, 5);
    expect(eye[2]).toBeCloseTo(0, 5);
  });

  it('spin advances yaw over time', () => {
    const still = cameraEye(base, 0).eye;
    const moved = cameraEye({ ...base, spin: 0.1 }, 1).eye;
    expect(moved[0]).not.toBeCloseTo(still[0], 2);
    expect(Math.hypot(...moved)).toBeCloseTo(6, 5);
  });

  it('positive pitch raises the eye', () => {
    expect(cameraEye({ ...base, pitch: 0.5 }, 0).eye[1]).toBeGreaterThan(0);
  });
});

describe('camFromParams', () => {
  it('reads the camera params back out', () => {
    const params: Record<string, number> = {};
    for (const p of CAMERA_PARAMS) params[p.id] = p.default;
    expect(camFromParams(params)).toEqual({
      dist: 6, yaw: 0, pitch: 0.18, fov: 0.9, spin: 0.08,
    });
  });
});
