/**
 * Shared per-node 3D camera — VISUALIZER_3D_PLAN.md.
 * One CPU camera definition feeds both render paths: raymarch nodes pass the
 * resolved eye/target/fov as uniforms and build the ray in WGSL (CAMERA_WGSL
 * in passes.ts); the raster path (PR2) turns the same eye/target/fov into a
 * view-projection matrix. Pure data — no GPU/DOM — so it unit-tests in node.
 *
 * Convention: the camera orbits the world origin. `yaw`/`spin` are in turns
 * (1 = 360°); `spin` adds turns-per-second so the view rotates on its own.
 */

import type { VisParamSpec } from './types';

export interface Cam {
  /** Orbit radius (world units). */
  dist: number;
  /** Horizontal angle, turns (0–1, wraps); add-wrap so audio nudges it. */
  yaw: number;
  /** Vertical angle, radians (+ looks down from above). */
  pitch: number;
  /** Vertical field of view, radians. */
  fov: number;
  /** Auto-orbit speed, turns per second. */
  spin: number;
}

/**
 * Camera params spread into every 3D node def. Continuous params auto-get
 * control in-ports at registry build, so audio can push the camera
 * (e.g. bass → dist zooms in on the beat). `yaw` is circular (add-wrap).
 */
export const CAMERA_PARAMS: VisParamSpec[] = [
  { id: 'dist', label: 'Distance', min: 1, max: 24, default: 6 },
  { id: 'yaw', label: 'Yaw', min: 0, max: 1, default: 0, modMode: 'add-wrap' },
  { id: 'pitch', label: 'Pitch', min: -0.7, max: 0.7, default: 0.18 },
  { id: 'fov', label: 'FOV', min: 0.4, max: 1.6, default: 0.9 },
  { id: 'spin', label: 'Spin', min: -1, max: 1, default: 0.08 },
];

export type Vec3 = [number, number, number];

/** Resolve the orbiting eye position (and origin target) for a frame. */
export function cameraEye(p: Cam, time: number): { eye: Vec3; target: Vec3 } {
  const a = (p.yaw + time * p.spin) * Math.PI * 2;
  const cp = Math.cos(p.pitch);
  const eye: Vec3 = [
    p.dist * cp * Math.sin(a),
    p.dist * Math.sin(p.pitch),
    p.dist * cp * Math.cos(a),
  ];
  return { eye, target: [0, 0, 0] };
}

/** Pull a Cam out of a node's resolved params (defaults already applied). */
export function camFromParams(params: Record<string, number>): Cam {
  return {
    dist: params.dist,
    yaw: params.yaw,
    pitch: params.pitch,
    fov: params.fov,
    spin: params.spin,
  };
}
