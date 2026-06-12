import { describe, expect, it } from 'vitest';
import { Graph } from './graph';
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
