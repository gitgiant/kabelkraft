/**
 * Standard MIDI File (SMF) read/write for the Composer piano roll.
 *
 * Times are converted to/from beats via the file's PPQ division — tempo metas
 * don't affect beat positions, so the clip lands on the same musical grid
 * regardless of the source tempo. Per-note extras map to MIDI as:
 *   vel → note-on velocity · release → note-off velocity ·
 *   pan → CC10 · modX → CC1 (mod wheel) · modY → CC74.
 */

import type { ComposerNote } from './composer';
import { sanitizeNote } from './composer';

export const SMF_PPQ = 480;

// ---------------------------------------------------------------------------
// Writer — format 0, one track
// ---------------------------------------------------------------------------

function vlq(value: number): number[] {
  let v = Math.max(0, Math.round(value));
  const bytes = [v & 0x7f];
  while ((v >>= 7) > 0) bytes.unshift((v & 0x7f) | 0x80);
  return bytes;
}

export function writeSmf(notes: ComposerNote[], lengthBeats: number, tempo = 120): Uint8Array {
  type Ev = { tick: number; order: number; bytes: number[] };
  const events: Ev[] = [];
  const tick = (beats: number) => Math.round(beats * SMF_PPQ);

  // Tempo meta so DAWs open the file at the project tempo.
  const usPerQuarter = Math.round(60_000_000 / Math.max(20, Math.min(300, tempo)));
  events.push({
    tick: 0,
    order: 0,
    bytes: [0xff, 0x51, 0x03, (usPerQuarter >> 16) & 0xff, (usPerQuarter >> 8) & 0xff, usPerQuarter & 0xff],
  });

  // CCs emitted only when the value changes — avoids a flood of duplicates.
  const lastCc: Record<number, number> = {};
  const cc = (t: number, controller: number, value: number) => {
    const v = Math.max(0, Math.min(127, Math.round(value)));
    if (lastCc[controller] === v) return;
    lastCc[controller] = v;
    events.push({ tick: t, order: 1, bytes: [0xb0, controller, v] });
  };

  const to7 = (v: number) => Math.max(0, Math.min(127, Math.round(v * 127)));
  for (const n of [...notes].sort((a, b) => a.start - b.start)) {
    const t0 = tick(n.start);
    cc(t0, 10, ((n.pan + 1) / 2) * 127);
    cc(t0, 1, n.modX * 127);
    cc(t0, 74, n.modY * 127);
    events.push({ tick: t0, order: 2, bytes: [0x90, n.pitch & 0x7f, Math.max(1, to7(n.vel))] });
    events.push({
      tick: tick(n.start + n.length),
      order: 1, // note-offs before simultaneous note-ons (retrigger same pitch)
      bytes: [0x80, n.pitch & 0x7f, to7(n.release)],
    });
  }

  events.sort((a, b) => a.tick - b.tick || a.order - b.order);

  const track: number[] = [];
  let prevTick = 0;
  for (const ev of events) {
    track.push(...vlq(ev.tick - prevTick), ...ev.bytes);
    prevTick = ev.tick;
  }
  track.push(...vlq(Math.max(0, tick(lengthBeats) - prevTick)), 0xff, 0x2f, 0x00);

  const header = [
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, // "MThd", length 6
    0, 0, // format 0
    0, 1, // one track
    (SMF_PPQ >> 8) & 0xff, SMF_PPQ & 0xff,
  ];
  const trackHeader = [
    0x4d, 0x54, 0x72, 0x6b, // "MTrk"
    (track.length >>> 24) & 0xff, (track.length >>> 16) & 0xff, (track.length >>> 8) & 0xff, track.length & 0xff,
  ];
  return new Uint8Array([...header, ...trackHeader, ...track]);
}

// ---------------------------------------------------------------------------
// Parser — formats 0 and 1
// ---------------------------------------------------------------------------

/** One sounding note from the file, in beats, with its source track/channel. */
export interface SmfNote extends ComposerNote {
  channel: number;
  track: number;
}

export interface SmfTrackInfo {
  index: number;
  name?: string;
  channels: number[];
  noteCount: number;
}

export interface SmfFile {
  ppq: number;
  /** Beats per minute from the first tempo meta, if any. */
  tempo?: number;
  tracks: SmfTrackInfo[];
  notes: SmfNote[];
  /** End of the last note in beats (suggested clip length before rounding). */
  lengthBeats: number;
}

class Reader {
  pos = 0;
  constructor(private bytes: Uint8Array) {}
  get remaining(): number {
    return this.bytes.length - this.pos;
  }
  u8(): number {
    if (this.pos >= this.bytes.length) throw new Error('Unexpected end of MIDI file');
    return this.bytes[this.pos++];
  }
  peek(): number {
    return this.bytes[this.pos];
  }
  u16(): number {
    return (this.u8() << 8) | this.u8();
  }
  u32(): number {
    return ((this.u8() << 24) | (this.u8() << 16) | (this.u8() << 8) | this.u8()) >>> 0;
  }
  vlq(): number {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      const b = this.u8();
      v = (v << 7) | (b & 0x7f);
      if (!(b & 0x80)) break;
    }
    return v;
  }
  skip(n: number): void {
    this.pos += n;
  }
  slice(n: number): Uint8Array {
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}

export function parseSmf(buffer: ArrayBuffer): SmfFile {
  const r = new Reader(new Uint8Array(buffer));
  if (r.u32() !== 0x4d546864) throw new Error('Not a MIDI file (missing MThd)');
  const headerLen = r.u32();
  const format = r.u16();
  const trackCount = r.u16();
  const division = r.u16();
  r.skip(headerLen - 6);
  if (format > 1) throw new Error(`Unsupported MIDI format ${format} (only 0 and 1)`);
  if (division & 0x8000) throw new Error('SMPTE-timed MIDI files are not supported');
  const ppq = division || SMF_PPQ;

  const file: SmfFile = { ppq, tracks: [], notes: [], lengthBeats: 0 };

  for (let trackIdx = 0; trackIdx < trackCount; trackIdx++) {
    if (r.remaining < 8) break; // tolerate truncated files
    if (r.u32() !== 0x4d54726b) throw new Error('Corrupt MIDI file (missing MTrk)');
    const length = r.u32();
    const end = r.pos + length;

    const info: SmfTrackInfo = { index: trackIdx, channels: [], noteCount: 0 };
    // Held notes keyed by channel:pitch; CC state per channel for pan/modX/modY.
    const held = new Map<string, { startTick: number; vel: number; pan: number; modX: number; modY: number }>();
    const ccState: Record<number, { pan: number; modX: number; modY: number }> = {};
    const ccFor = (ch: number) => (ccState[ch] ??= { pan: 0, modX: 0, modY: 0 });

    let tick = 0;
    let status = 0;
    while (r.pos < end) {
      tick += r.vlq();
      let b = r.u8();
      if (b < 0x80) {
        // Running status: data byte of the previous event type.
        if (!status) throw new Error('Corrupt MIDI file (running status without status)');
        r.skip(-1);
        b = status;
      } else if (b < 0xf0) {
        status = b;
      }

      if (b === 0xff) {
        const type = r.u8();
        const len = r.vlq();
        const data = r.slice(len);
        if (type === 0x03 && !info.name) {
          info.name = new TextDecoder().decode(data).trim() || undefined;
        } else if (type === 0x51 && len === 3 && file.tempo === undefined) {
          const us = (data[0] << 16) | (data[1] << 8) | data[2];
          if (us > 0) file.tempo = Math.round(60_000_000 / us);
        }
        continue;
      }
      if (b === 0xf0 || b === 0xf7) {
        r.skip(r.vlq()); // sysex
        continue;
      }

      const kind = b & 0xf0;
      const ch = b & 0x0f;
      const d1 = r.u8();
      const d2 = kind === 0xc0 || kind === 0xd0 ? 0 : r.u8();

      if (kind === 0xb0) {
        const st = ccFor(ch);
        if (d1 === 10) st.pan = (d2 / 127) * 2 - 1;
        else if (d1 === 1) st.modX = d2 / 127;
        else if (d1 === 74) st.modY = d2 / 127;
        continue;
      }

      const key = `${ch}:${d1}`;
      if (kind === 0x90 && d2 > 0) {
        if (!info.channels.includes(ch)) info.channels.push(ch);
        const st = ccFor(ch);
        // Same pitch retriggered while held: close the first note here.
        const prev = held.get(key);
        if (prev) closeNote(file, info, trackIdx, ch, d1, prev, tick, 0, ppq);
        held.set(key, { startTick: tick, vel: d2 / 127, pan: st.pan, modX: st.modX, modY: st.modY });
      } else if (kind === 0x80 || (kind === 0x90 && d2 === 0)) {
        const open = held.get(key);
        if (open) {
          held.delete(key);
          closeNote(file, info, trackIdx, ch, d1, open, tick, kind === 0x80 ? d2 / 127 : 0.5, ppq);
        }
      }
    }
    // Notes still held at end-of-track close at the track end.
    for (const [key, open] of held) {
      const [ch, pitch] = key.split(':').map(Number);
      closeNote(file, info, trackIdx, ch, pitch, open, tick, 0.5, ppq);
    }
    r.pos = end;
    file.tracks.push(info);
  }

  for (const n of file.notes) {
    file.lengthBeats = Math.max(file.lengthBeats, n.start + n.length);
  }
  return file;
}

function closeNote(
  file: SmfFile,
  info: SmfTrackInfo,
  track: number,
  channel: number,
  pitch: number,
  open: { startTick: number; vel: number; pan: number; modX: number; modY: number },
  endTick: number,
  release: number,
  ppq: number,
): void {
  info.noteCount++;
  file.notes.push({
    ...sanitizeNote({
      start: open.startTick / ppq,
      length: Math.max(1 / 64, (endTick - open.startTick) / ppq),
      pitch,
      vel: open.vel,
      release,
      pan: open.pan,
      modX: open.modX,
      modY: open.modY,
      prob: 1,
    }),
    channel,
    track,
  });
}
