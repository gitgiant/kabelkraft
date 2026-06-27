/**
 * Parity guard for the engine-type manifest. The set of module types is now
 * declared once (registry ENGINE_TYPES); three things must agree with it, and
 * historically drifted by hand:
 *   - the worklet's MODULE_FACTORIES (the DSP dispatch), and
 *   - engine.ts's syncGraph filter (ENGINE_MODULE_TYPES, derived here too).
 * This test loads the real worklet in a Node VM realm (same trick as
 * worklet-smoke.test.ts) and asserts its factory keys equal ENGINE_TYPES, in
 * both directions — a worklet class with no registry entry, or a registry type
 * with no DSP factory, fails the build instead of shipping a silent gap.
 */

/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { ENGINE_TYPES } from '../core/registry';

const WORKLET_PATH = fileURLToPath(new URL('../../public/engine-worklet.js', import.meta.url));

/** Load the worklet source and hand back the registered processor class. */
function loadProcessorClass(): { MODULE_TYPES?: string[] } {
  const registered = { cls: null as { MODULE_TYPES?: string[] } | null };
  class AudioWorkletProcessor {
    port = { onmessage: null, postMessage: () => {} };
  }
  const sandbox = {
    sampleRate: 48000,
    currentTime: 0,
    AudioWorkletProcessor,
    registerProcessor: (_name: string, cls: { MODULE_TYPES?: string[] }) => {
      registered.cls = cls;
    },
    Date,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(WORKLET_PATH, 'utf8'), sandbox, { filename: 'engine-worklet.js' });
  if (!registered.cls) throw new Error('worklet did not register a processor');
  return registered.cls;
}

describe('engine-type manifest parity (registry ↔ worklet)', () => {
  it('worklet MODULE_FACTORIES keys exactly equal registry ENGINE_TYPES', () => {
    const cls = loadProcessorClass();
    expect(cls.MODULE_TYPES, 'worklet must expose EngineProcessor.MODULE_TYPES').toBeDefined();

    const worklet = new Set(cls.MODULE_TYPES);
    const registry = new Set<string>(ENGINE_TYPES);

    const missingFactory = [...registry].filter((t) => !worklet.has(t));
    const missingRegistry = [...worklet].filter((t) => !registry.has(t));

    expect(missingFactory, 'registry types with no worklet DSP factory').toEqual([]);
    expect(missingRegistry, 'worklet factories with no registry ENGINE_TYPES entry').toEqual([]);
  });

  it('ENGINE_TYPES has no duplicates', () => {
    expect(ENGINE_TYPES.length).toBe(new Set(ENGINE_TYPES).size);
  });
});
