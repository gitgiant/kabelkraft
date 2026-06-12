import { describe, expect, it, vi } from 'vitest';
import { MidiManager } from './midi';

function fakeAccess(inputs: Array<{ id: string; name: string }>) {
  return {
    inputs: new Map(inputs.map((d) => [d.id, { ...d, onmidimessage: null }])),
    outputs: new Map(),
    onstatechange: null,
  };
}

describe('MidiManager', () => {
  it('init failure does not latch — the next call retries', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error('needs a user gesture'))
      .mockResolvedValue(fakeAccess([{ id: 'in1', name: 'Keys' }]));
    vi.stubGlobal('navigator', { requestMIDIAccess: request });

    const m = new MidiManager();
    await m.init();
    expect(m.ready).toBe(false);
    expect(m.inputs()).toEqual([]);

    await m.init(); // retry succeeds (e.g. from the Options MIDI tab click)
    expect(m.ready).toBe(true);
    expect(m.inputs()).toEqual([{ id: 'in1', name: 'Keys' }]);
    expect(request).toHaveBeenCalledTimes(2);

    await m.init(); // already live — no third request
    expect(request).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it('disabled inputs still blink/log but stop reaching listeners', () => {
    const m = new MidiManager();
    const seen: string[] = [];
    m.onMessage((deviceId) => seen.push(deviceId));

    m.simulateMessage('dev1', [0x90, 60, 100]);
    expect(seen).toEqual(['dev1']);

    m.disabledInputs.add('dev1');
    m.simulateMessage('dev1', [0x90, 62, 100]);
    expect(seen).toEqual(['dev1']); // listener not called again
    expect(m.recvLog.length).toBe(2); // monitor still records
    expect(m.lastActivity.has('dev1')).toBe(true); // activity blink still works
  });
});
