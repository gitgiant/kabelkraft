/**
 * Visual node definitions — VISUALIZER_ENGINE_PLAN.md (Phase 2 catalog).
 * Source nodes read the container's shared VisFeatures implicitly (the audio
 * pole feeds every node); the Features node additionally exposes the analysis
 * as control-rate outputs. A wired control in-port whose id matches a param
 * id multiplies that param's set value (0–1 scale).
 */

import type { VisNodeDef, VisPortSpec } from './types';

const visOut: VisPortSpec = {
  id: 'out',
  label: 'Out',
  type: 'visual',
  direction: 'out',
  description: 'Rendered frame.',
};

const visIn: VisPortSpec = {
  id: 'in',
  label: 'In',
  type: 'visual',
  direction: 'in',
  description: 'Input frame.',
};

/** Control in-port that scales the same-named param. */
function modPort(paramId: string, what: string): VisPortSpec {
  return {
    id: paramId,
    label: paramId[0].toUpperCase() + paramId.slice(1),
    type: 'control',
    direction: 'in',
    description: `Scales ${what} (0–1, e.g. from Features bass/level).`,
  };
}

const features: VisNodeDef = {
  type: 'features',
  name: 'Features',
  category: 'util',
  description:
    'Presents the container audio input as control signals: level, band energies and onsets. ' +
    'Wire these to source/effect params to make visuals move with the music.',
  ports: [
    { id: 'level', label: 'Level', type: 'control', direction: 'out', description: 'RMS level, 0–1.' },
    { id: 'bass', label: 'Bass', type: 'control', direction: 'out', description: 'Low-band energy (20–250 Hz), 0–1.' },
    { id: 'mid', label: 'Mid', type: 'control', direction: 'out', description: 'Mid-band energy (250 Hz–2 kHz), 0–1.' },
    { id: 'high', label: 'High', type: 'control', direction: 'out', description: 'High-band energy (2–8 kHz), 0–1.' },
    { id: 'onset', label: 'Onset', type: 'control', direction: 'out', description: 'Beat/onset strength, decays each frame.' },
    { id: 'ctrl', label: 'Mod', type: 'control', direction: 'out', description: 'The container Mod pole value (neutral 1 while the pole is unwired).' },
  ],
  params: [],
};

// -- sources -------------------------------------------------------------

const spectrum: VisNodeDef = {
  type: 'spectrum',
  name: 'Spectrum',
  category: 'source',
  description: 'Frequency bars from the container audio input (64 log-spaced bins).',
  ports: [modPort('gain', 'bar height'), visOut],
  params: [{ id: 'gain', label: 'Gain', min: 0.5, max: 4, default: 1.5 }],
};

const scope: VisNodeDef = {
  type: 'scope',
  name: 'Scope',
  category: 'source',
  description: 'Oscilloscope trace of the container audio input, with glow.',
  ports: [modPort('gain', 'trace amplitude'), visOut],
  params: [
    { id: 'gain', label: 'Gain', min: 0.5, max: 4, default: 1.5 },
    { id: 'glow', label: 'Glow', min: 0, max: 1, default: 0.4 },
  ],
};

const particles: VisNodeDef = {
  type: 'particles',
  name: 'Particles',
  category: 'source',
  description:
    'Particle bursts spawned by note events and onsets; audio energy drives drift speed.',
  ports: [modPort('gain', 'drift speed'), visOut],
  params: [
    { id: 'gain', label: 'Gain', min: 0.5, max: 4, default: 1.5 },
    { id: 'rate', label: 'Rate', min: 0, max: 1, default: 0.5 },
    { id: 'size', label: 'Size', min: 0.3, max: 3, default: 1 },
  ],
};

const shapes: VisNodeDef = {
  type: 'shapes',
  name: 'Shapes',
  category: 'source',
  description:
    'Tiled geometric shapes (circle/ring/square/hex). Pulse makes size follow the audio level.',
  ports: [modPort('size', 'shape size'), visOut],
  params: [
    { id: 'shape', label: 'Shape', min: 0, max: 3, default: 0, options: ['circle', 'ring', 'square', 'hex'] },
    { id: 'count', label: 'Count', min: 1, max: 12, default: 4 },
    { id: 'size', label: 'Size', min: 0.05, max: 1, default: 0.5 },
    { id: 'spin', label: 'Spin', min: -2, max: 2, default: 0.2 },
    { id: 'pulse', label: 'Pulse', min: 0, max: 1, default: 0.5 },
    { id: 'hue', label: 'Hue', min: 0, max: 1, default: 0.55 },
  ],
};

const gradient: VisNodeDef = {
  type: 'gradient',
  name: 'Gradient',
  category: 'source',
  description: 'Background fill: solid, linear or radial two-color gradient; hue can drift over time.',
  ports: [visOut],
  params: [
    { id: 'mode', label: 'Mode', min: 0, max: 3, default: 1, options: ['solid', 'vertical', 'horizontal', 'radial'] },
    { id: 'hue', label: 'Hue', min: 0, max: 1, default: 0.65 },
    { id: 'hue2', label: 'Hue 2', min: 0, max: 1, default: 0.85 },
    { id: 'sat', label: 'Sat', min: 0, max: 1, default: 0.7 },
    { id: 'lum', label: 'Lum', min: 0, max: 0.8, default: 0.25 },
    { id: 'drift', label: 'Drift', min: 0, max: 1, default: 0 },
  ],
};

const FIT_OPTIONS = ['cover', 'contain', 'stretch'];

const image: VisNodeDef = {
  type: 'image',
  name: 'Image',
  category: 'source',
  description:
    'A picture (PNG transparency preserved). Pick the file in the editor; it is saved with the project.',
  ports: [visOut],
  params: [{ id: 'fit', label: 'Fit', min: 0, max: 2, default: 0, options: FIT_OPTIONS }],
};

const video: VisNodeDef = {
  type: 'video',
  name: 'Video',
  category: 'source',
  description:
    'A looping video file. Picked per session in the editor (not embedded in project saves).',
  ports: [visOut],
  params: [{ id: 'fit', label: 'Fit', min: 0, max: 2, default: 0, options: FIT_OPTIONS }],
};

const webcam: VisNodeDef = {
  type: 'webcam',
  name: 'Webcam',
  category: 'source',
  description: 'Live camera feed (asks for permission when the visualizer runs).',
  ports: [visOut],
  params: [
    { id: 'fit', label: 'Fit', min: 0, max: 2, default: 0, options: FIT_OPTIONS },
    { id: 'mirror', label: 'Mirror', min: 0, max: 1, default: 1, options: ['off', 'on'] },
  ],
};

export const TEXTLAYER_MODES = ['line', 'scroll', 'typewriter', 'stack'];

const textlayer: VisNodeDef = {
  type: 'textlayer',
  name: 'Text Layer',
  category: 'source',
  description:
    'Draws the container Text input (lyrics, readouts). Modes: line (current text), ' +
    'scroll (marquee), typewriter, stack (karaoke history — interim words glow). ' +
    'With nothing wired it shows the fallback text set in the inspector.',
  ports: [modPort('size', 'text size'), visOut],
  params: [
    { id: 'mode', label: 'Mode', min: 0, max: TEXTLAYER_MODES.length - 1, default: 0, options: [...TEXTLAYER_MODES] },
    { id: 'size', label: 'Size', min: 0.04, max: 0.3, default: 0.12 },
    { id: 'hue', label: 'Hue', min: 0, max: 1, default: 0.55 },
    { id: 'sat', label: 'Sat', min: 0, max: 1, default: 0 },
    { id: 'speed', label: 'Speed', min: 0.2, max: 4, default: 1 },
    { id: 'y', label: 'Y', min: 0.1, max: 0.9, default: 0.5 },
  ],
};

// -- effects -------------------------------------------------------------

const blur: VisNodeDef = {
  type: 'blur',
  name: 'Blur',
  category: 'effect',
  description: 'Gaussian blur (two-pass separable).',
  ports: [visIn, modPort('amount', 'blur radius'), visOut],
  params: [{ id: 'amount', label: 'Amount', min: 0, max: 1, default: 0.3 }],
};

const pixelate: VisNodeDef = {
  type: 'pixelate',
  name: 'Pixelate',
  category: 'effect',
  description: 'Quantizes the frame into mosaic cells.',
  ports: [visIn, modPort('amount', 'cell size'), visOut],
  params: [{ id: 'amount', label: 'Amount', min: 0, max: 1, default: 0.3 }],
};

const feedback: VisNodeDef = {
  type: 'feedback',
  name: 'Feedback',
  category: 'effect',
  description:
    'Mixes in last frame zoomed/rotated/faded — trails, tunnels, infinite smear. The classic.',
  ports: [visIn, modPort('zoom', 'zoom rate'), visOut],
  params: [
    { id: 'zoom', label: 'Zoom', min: -1, max: 1, default: 0.15 },
    { id: 'spin', label: 'Spin', min: -1, max: 1, default: 0 },
    { id: 'fade', label: 'Fade', min: 0.5, max: 0.99, default: 0.92 },
  ],
};

const kaleido: VisNodeDef = {
  type: 'kaleido',
  name: 'Kaleidoscope',
  category: 'effect',
  description: 'Mirror-folds the frame into N wedges around the center.',
  ports: [visIn, modPort('spin', 'rotation speed'), visOut],
  params: [
    { id: 'segments', label: 'Segments', min: 2, max: 16, default: 6 },
    { id: 'spin', label: 'Spin', min: -1, max: 1, default: 0.1 },
  ],
};

const colorgrade: VisNodeDef = {
  type: 'colorgrade',
  name: 'Color Grade',
  category: 'effect',
  description: 'Hue shift, saturation, contrast, brightness, invert.',
  ports: [visIn, modPort('hueShift', 'hue rotation'), visOut],
  params: [
    { id: 'hueShift', label: 'Hue Shift', min: 0, max: 1, default: 0 },
    { id: 'sat', label: 'Sat', min: 0, max: 2, default: 1 },
    { id: 'contrast', label: 'Contrast', min: 0.5, max: 2, default: 1 },
    { id: 'bright', label: 'Bright', min: 0.5, max: 2, default: 1 },
    { id: 'invert', label: 'Invert', min: 0, max: 1, default: 0, options: ['off', 'on'] },
  ],
};

const chromashift: VisNodeDef = {
  type: 'chromashift',
  name: 'Chroma Shift',
  category: 'effect',
  description: 'Splits RGB channels apart — glitch / VHS fringe.',
  ports: [visIn, modPort('amount', 'split distance'), visOut],
  params: [
    { id: 'amount', label: 'Amount', min: 0, max: 1, default: 0.3 },
    { id: 'angle', label: 'Angle', min: 0, max: 1, default: 0 },
  ],
};

const warp: VisNodeDef = {
  type: 'warp',
  name: 'Warp',
  category: 'effect',
  description: 'Sine-field displacement — liquid wobble.',
  ports: [visIn, modPort('amount', 'displacement'), visOut],
  params: [
    { id: 'amount', label: 'Amount', min: 0, max: 1, default: 0.3 },
    { id: 'freq', label: 'Freq', min: 1, max: 30, default: 8 },
    { id: 'speed', label: 'Speed', min: 0, max: 4, default: 1 },
  ],
};

const bloom: VisNodeDef = {
  type: 'bloom',
  name: 'Bloom',
  category: 'effect',
  description: 'Bright areas glow and bleed — synthwave mandatory.',
  ports: [visIn, modPort('amount', 'glow strength'), visOut],
  params: [
    { id: 'threshold', label: 'Threshold', min: 0, max: 1, default: 0.5 },
    { id: 'amount', label: 'Amount', min: 0, max: 2, default: 0.8 },
  ],
};

const mirror: VisNodeDef = {
  type: 'mirror',
  name: 'Mirror',
  category: 'effect',
  description: 'Reflects the frame across an axis (or both).',
  ports: [visIn, visOut],
  params: [{ id: 'mode', label: 'Mode', min: 0, max: 2, default: 0, options: ['x', 'y', 'quad'] }],
};

// -- combine / util --------------------------------------------------------

const blend: VisNodeDef = {
  type: 'blend',
  name: 'Blend',
  category: 'combine',
  description: 'Composites two frames; stack Blends for more layers.',
  ports: [
    { id: 'a', label: 'A', type: 'visual', direction: 'in', description: 'Bottom layer.' },
    { id: 'b', label: 'B', type: 'visual', direction: 'in', description: 'Top layer.' },
    modPort('mix', 'layer B opacity'),
    visOut,
  ],
  params: [
    { id: 'mode', label: 'Mode', min: 0, max: 4, default: 0, options: ['over', 'add', 'screen', 'multiply', 'difference'] },
    { id: 'mix', label: 'Mix', min: 0, max: 1, default: 1 },
  ],
};

const visualin: VisNodeDef = {
  type: 'visualin',
  name: 'Visual In',
  category: 'util',
  description:
    'The container Vis In pole — the frame from an upstream visualizer wired on the main ' +
    'canvas. Blend it with local sources to layer scenes.',
  ports: [{ ...visOut, description: 'Upstream visualizer frame (transparent when unwired).' }],
  params: [{ id: 'fit', label: 'Fit', min: 0, max: 2, default: 0, options: FIT_OPTIONS }],
};

const output: VisNodeDef = {
  type: 'output',
  name: 'Output',
  category: 'util',
  description: 'The container frame output — what the tile, big view and visual wires show.',
  ports: [{ ...visIn, description: 'Final frame.' }],
  params: [],
};

export const VIS_NODE_DEFS: Map<string, VisNodeDef> = new Map(
  [
    features,
    spectrum,
    scope,
    particles,
    shapes,
    gradient,
    image,
    video,
    webcam,
    textlayer,
    blur,
    pixelate,
    feedback,
    kaleido,
    colorgrade,
    chromashift,
    warp,
    bloom,
    mirror,
    blend,
    visualin,
    output,
  ].map((d) => [d.type, d]),
);

/** Visual in-ports of a def, in declaration order (evaluator input slots). */
export function visualInPorts(def: VisNodeDef): VisPortSpec[] {
  return def.ports.filter((p) => p.type === 'visual' && p.direction === 'in');
}
