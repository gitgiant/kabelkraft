/**
 * WebMIDI access layer (PRD §8.7). One manager owns the MIDIAccess; MIDI In /
 * MIDI Out modules and MIDI-learn subscribe through it. Feature-detected —
 * Firefox/Safari without WebMIDI just see "no devices". Tests inject messages
 * via simulateMessage / capture sends via sentLog.
 */

export interface MidiDeviceInfo {
  id: string;
  name: string;
}

export type MidiListener = (deviceId: string, data: Uint8Array) => void;

interface MidiPortLike {
  id: string;
  name?: string | null;
  onmidimessage?: ((e: { data: Uint8Array }) => void) | null;
  send?: (data: number[] | Uint8Array) => void;
}

interface MidiAccessLike {
  inputs: Map<string, MidiPortLike>;
  outputs: Map<string, MidiPortLike>;
  onstatechange: (() => void) | null;
}

export class MidiManager {
  private access: MidiAccessLike | null = null;
  private listeners = new Set<MidiListener>();
  private initStarted = false;
  /** Test hook: messages sent to outputs (also fed when no device exists). */
  readonly sentLog: Array<{ deviceId: string; data: number[] }> = [];
  /** Incoming messages, newest last (Options → Debug MIDI monitor). */
  readonly recvLog: Array<{ deviceId: string; data: number[]; t: number }> = [];
  /** Last receive time (ms epoch) per input device — activity blink. */
  readonly lastActivity = new Map<string, number>();
  /** Input ids whose messages are dropped (Options → MIDI, settings-backed). */
  disabledInputs = new Set<string>();

  get supported(): boolean {
    return typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator;
  }

  /** Lazy init; safe to call repeatedly. */
  async init(): Promise<void> {
    if (this.initStarted || !this.supported) return;
    this.initStarted = true;
    try {
      const access = (await (navigator as Navigator & {
        requestMIDIAccess(opts?: { sysex?: boolean }): Promise<unknown>;
      }).requestMIDIAccess({ sysex: false })) as unknown as MidiAccessLike;
      this.access = access;
      const attach = () => {
        for (const input of access.inputs.values()) {
          input.onmidimessage = (e) => this.dispatch(input.id, e.data);
        }
      };
      access.onstatechange = attach;
      attach();
    } catch {
      // Permission denied or unavailable — modules just see no devices.
    }
  }

  inputs(): MidiDeviceInfo[] {
    if (!this.access) return [];
    return [...this.access.inputs.values()].map((p) => ({ id: p.id, name: p.name ?? p.id }));
  }

  outputs(): MidiDeviceInfo[] {
    if (!this.access) return [];
    return [...this.access.outputs.values()].map((p) => ({ id: p.id, name: p.name ?? p.id }));
  }

  onMessage(listener: MidiListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private dispatch(deviceId: string, data: Uint8Array): void {
    // Activity + monitor record even for disabled devices ("is it seen?"),
    // only the listener fan-out is gated.
    this.lastActivity.set(deviceId, Date.now());
    this.recvLog.push({ deviceId, data: [...data], t: Date.now() });
    if (this.recvLog.length > 256) this.recvLog.shift();
    if (this.disabledInputs.has(deviceId)) return;
    for (const l of this.listeners) l(deviceId, data);
  }

  /** deviceId '' = first available output (and always the sentLog). */
  send(deviceId: string, data: number[]): void {
    this.sentLog.push({ deviceId, data });
    if (this.sentLog.length > 256) this.sentLog.shift();
    if (!this.access) return;
    const out = deviceId
      ? this.access.outputs.get(deviceId)
      : [...this.access.outputs.values()][0];
    out?.send?.(data);
  }

  /** Test hook: behave as if a device delivered these bytes. */
  simulateMessage(deviceId: string, data: number[]): void {
    this.dispatch(deviceId, new Uint8Array(data));
  }
}
