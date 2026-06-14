import { describe, expect, it } from 'vitest';
import { Graph } from './graph';
import { createInstance } from './module';
import { MODULE_DEFS } from './registry';
import { DEFAULT_TRANSPORT } from './types';
import { deserializeProject, serializeProject } from './serialize';

function emptyGraph(): Graph {
  return new Graph(MODULE_DEFS);
}

describe('project metadata', () => {
  it('round-trips meta through serialize/deserialize', () => {
    const json = serializeProject(
      'Meta Test',
      emptyGraph(),
      { ...DEFAULT_TRANSPORT, timeSignature: { num: 3, denom: 8 } },
      undefined,
      undefined,
      undefined,
      { artists: 'KK Crew', description: 'a test piece', picture: 'data:image/jpeg;base64,abc' },
    );
    const loaded = deserializeProject(json, MODULE_DEFS);
    expect(loaded.name).toBe('Meta Test');
    expect(loaded.meta.artists).toBe('KK Crew');
    expect(loaded.meta.description).toBe('a test piece');
    expect(loaded.meta.picture).toBe('data:image/jpeg;base64,abc');
    expect(loaded.transport.timeSignature).toEqual({ num: 3, denom: 8 });
  });

  it('defaults to empty meta when absent (older projects)', () => {
    const json = serializeProject('Old', emptyGraph(), { ...DEFAULT_TRANSPORT });
    const loaded = deserializeProject(json, MODULE_DEFS);
    expect(loaded.meta).toEqual({});
  });

  it('round-trips module and container presets through .kkproj', () => {
    const graph = emptyGraph();
    const osc = createInstance(MODULE_DEFS.get('osc')!, 0, 0);
    osc.presets = [{ id: 'p1', name: 'Saw', category: 'Default', params: { wave: 3 } }];
    osc.activePresetId = 'p1';
    graph.addModule(osc);
    const group = graph.createGroup('Synth', [osc.id], [], 0, 0);
    group.presets = [
      {
        id: 'g1',
        name: 'Bass',
        category: 'Bass',
        members: { [osc.id]: { params: { wave: 0 } } },
        wires: [],
      },
    ];
    group.activePresetId = 'g1';

    const loaded = deserializeProject(serializeProject('P', graph, { ...DEFAULT_TRANSPORT }), MODULE_DEFS);
    const loadedOsc = [...loaded.graph.modules.values()].find((m) => m.type === 'osc')!;
    expect(loadedOsc.activePresetId).toBe('p1');
    expect(loadedOsc.presets).toEqual([{ id: 'p1', name: 'Saw', category: 'Default', params: { wave: 3 } }]);
    const loadedGroup = [...loaded.graph.groups.values()][0];
    expect(loadedGroup.activePresetId).toBe('g1');
    expect(loadedGroup.presets![0].members![osc.id].params.wave).toBe(0);
  });

  it('drops non-image picture payloads', () => {
    const json = serializeProject(
      'Sus',
      emptyGraph(),
      { ...DEFAULT_TRANSPORT },
      undefined,
      undefined,
      undefined,
      { picture: 'javascript:alert(1)' },
    );
    expect(deserializeProject(json, MODULE_DEFS).meta.picture).toBeUndefined();
  });
});
