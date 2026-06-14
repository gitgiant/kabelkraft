import { describe, expect, it } from 'vitest';
import { COMPOSER_MAX_LENGTH, defaultNote, type ComposerClip } from './composer';
import { existingNotesPrompt, generateMidiSpecPack, parseKkMidi } from './aimidi';

const clip = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    kind: 'kkmidi',
    name: 'Test Riff',
    length: 8,
    notes: [
      { start: 0, length: 0.5, pitch: 60, vel: 0.9 },
      { start: 1.37, length: 0.25, pitch: 63, vel: 0.4, pan: -0.5, prob: 0.7 },
    ],
    ...over,
  });

describe('parseKkMidi', () => {
  it('accepts a valid clip and preserves free timing + expression', () => {
    const r = parseKkMidi(clip());
    expect(r.ok).toBe(true);
    expect(r.name).toBe('Test Riff');
    expect(r.clip!.length).toBe(8);
    expect(r.clip!.notes).toHaveLength(2);
    const free = r.clip!.notes.find((n) => n.pitch === 63)!;
    expect(free.start).toBeCloseTo(1.37);
    expect(free.pan).toBeCloseTo(-0.5);
    expect(free.prob).toBeCloseTo(0.7);
  });

  it('accepts a markdown reply with a ```json block', () => {
    const r = parseKkMidi('Here you go!\n```json\n' + clip() + '\n```\nEnjoy.');
    expect(r.ok).toBe(true);
  });

  it('rejects non-JSON and non-object payloads', () => {
    expect(parseKkMidi('not json').ok).toBe(false);
    expect(parseKkMidi('[1,2,3]').ok).toBe(false);
  });

  it('rejects missing/empty notes and missing note fields', () => {
    expect(parseKkMidi(clip({ notes: undefined })).ok).toBe(false);
    expect(parseKkMidi(clip({ notes: [] })).ok).toBe(false);
    const r = parseKkMidi(clip({ notes: [{ start: 0, pitch: 60 }] }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('length');
  });

  it('clamps length to the composer cap and drops notes past the loop end', () => {
    const r = parseKkMidi(
      clip({
        length: 999,
        notes: [
          { start: 0, length: 1, pitch: 60 },
          { start: 500, length: 1, pitch: 64 },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.clip!.length).toBe(COMPOSER_MAX_LENGTH);
    expect(r.clip!.notes).toHaveLength(1);
    expect(r.warnings.some((w) => w.includes('cap'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('dropped'))).toBe(true);
  });

  it('fails when every note is past the loop end', () => {
    const r = parseKkMidi(clip({ length: 4, notes: [{ start: 9, length: 1, pitch: 60 }] }));
    expect(r.ok).toBe(false);
  });

  it('clamps out-of-range note values instead of failing', () => {
    const r = parseKkMidi(
      clip({ notes: [{ start: -2, length: 0, pitch: 300, vel: 9, pan: -5 }] }),
    );
    expect(r.ok).toBe(true);
    const n = r.clip!.notes[0];
    expect(n.start).toBe(0);
    expect(n.length).toBeGreaterThan(0);
    expect(n.pitch).toBe(127);
    expect(n.vel).toBe(1);
    expect(n.pan).toBe(-1);
  });
});

describe('generateMidiSpecPack', () => {
  it('mentions the beat cap and puts the user prompt first', () => {
    const pack = generateMidiSpecPack('a funky bassline');
    expect(pack).toContain(String(COMPOSER_MAX_LENGTH));
    expect(pack).toContain('USER PROMPT: a funky bassline');
    // Prompt at the very top so the model doesn't have to dig past the spec.
    expect(pack.startsWith('USER PROMPT: a funky bassline')).toBe(true);
  });
});

describe('existingNotesPrompt', () => {
  const clipOf = (notes: ComposerClip['notes']): ComposerClip => ({ notes, length: 8 });

  it('emits a kkmidi block carrying the notes', () => {
    const out = existingNotesPrompt(clipOf([defaultNote(0, 60)]));
    expect(out).toContain('Variate on existing notes');
    const json = JSON.parse(out.match(/```json\n(.*?)\n```/s)![1]);
    expect(json.kind).toBe('kkmidi');
    expect(json.length).toBe(8);
    expect(json.notes[0]).toMatchObject({ start: 0, pitch: 60, vel: 0.8 });
  });

  it('omits per-note fields left at their defaults', () => {
    const out = existingNotesPrompt(clipOf([defaultNote(0, 60)]));
    const n = JSON.parse(out.match(/```json\n(.*?)\n```/s)![1]).notes[0];
    expect(n).not.toHaveProperty('pan');
    expect(n).not.toHaveProperty('prob');
    expect(n).not.toHaveProperty('release');
  });

  it('includes non-default per-note fields', () => {
    const note = { ...defaultNote(0, 60), pan: -0.5, prob: 0.7 };
    const n = JSON.parse(
      existingNotesPrompt(clipOf([note])).match(/```json\n(.*?)\n```/s)![1],
    ).notes[0];
    expect(n.pan).toBe(-0.5);
    expect(n.prob).toBe(0.7);
  });
});
