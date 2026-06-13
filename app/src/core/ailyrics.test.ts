import { describe, expect, it } from 'vitest';
import {
  generateLyricsSpecPack,
  parseKkLyrics,
  LYRICS_MAX_START,
} from './ailyrics';

const sheet = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    kind: 'kklyrics',
    name: 'Test Song',
    lines: [
      { start: 0, text: 'First line' },
      { start: 8, text: 'Second line', words: [{ off: 0, text: 'Second' }, { off: 1, text: 'line' }] },
    ],
    ...over,
  });

describe('parseKkLyrics', () => {
  it('accepts a valid sheet and keeps timing + word offsets', () => {
    const r = parseKkLyrics(sheet());
    expect(r.ok).toBe(true);
    expect(r.name).toBe('Test Song');
    expect(r.clip!.lines).toHaveLength(2);
    const second = r.clip!.lines.find((l) => l.start === 8)!;
    expect(second.text).toBe('Second line');
    expect(second.words).toHaveLength(2);
    expect(second.words![1].off).toBe(1);
  });

  it('accepts a markdown reply with a ```json block', () => {
    const r = parseKkLyrics('Here you go!\n```json\n' + sheet() + '\n```\nEnjoy.');
    expect(r.ok).toBe(true);
  });

  it('sorts lines by start beat', () => {
    const r = parseKkLyrics(
      sheet({ lines: [{ start: 16, text: 'C' }, { start: 0, text: 'A' }, { start: 4, text: 'B' }] }),
    );
    expect(r.ok).toBe(true);
    expect(r.clip!.lines.map((l) => l.text)).toEqual(['A', 'B', 'C']);
  });

  it('rejects non-JSON and non-object payloads', () => {
    expect(parseKkLyrics('not json').ok).toBe(false);
    expect(parseKkLyrics('[1,2,3]').ok).toBe(false);
  });

  it('rejects missing/empty lines', () => {
    expect(parseKkLyrics(sheet({ lines: undefined })).ok).toBe(false);
    expect(parseKkLyrics(sheet({ lines: [] })).ok).toBe(false);
  });

  it('reports lines missing start or text', () => {
    const r = parseKkLyrics(sheet({ lines: [{ text: 'no start' }] }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('start');
    const r2 = parseKkLyrics(sheet({ lines: [{ start: 0, text: '   ' }] }));
    expect(r2.ok).toBe(false);
    expect(r2.errors.join(' ')).toContain('text');
  });

  it('clamps out-of-range starts with a warning', () => {
    const r = parseKkLyrics(sheet({ lines: [{ start: -5, text: 'A' }, { start: 1e9, text: 'B' }] }));
    expect(r.ok).toBe(true);
    expect(r.clip!.lines[0].start).toBe(0);
    expect(r.clip!.lines[1].start).toBe(LYRICS_MAX_START);
    expect(r.warnings.some((w) => w.includes('clamped'))).toBe(true);
  });

  it('drops malformed word entries instead of failing', () => {
    const r = parseKkLyrics(sheet({ lines: [{ start: 0, text: 'A', words: [{ off: 'x', text: 'bad' }, { off: 2, text: 'ok' }] }] }));
    expect(r.ok).toBe(true);
    expect(r.clip!.lines[0].words).toHaveLength(1);
    expect(r.clip!.lines[0].words![0].text).toBe('ok');
  });
});

describe('generateLyricsSpecPack', () => {
  it('embeds the song context and appends the user prompt', () => {
    const pack = generateLyricsSpecPack('a summer pop song', {
      tempo: 128,
      timeSignature: { num: 3, denom: 4 },
    });
    expect(pack).toContain('128 BPM');
    expect(pack).toContain('3/4');
    expect(pack).toContain('USER PROMPT: a summer pop song');
  });
});
