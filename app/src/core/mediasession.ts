/**
 * Hardware media-key transport control via the Media Session API.
 *
 * Physical play/pause/stop/next/prev keys (laptop function rows, Bluetooth
 * headsets, OS media widgets) only reach a page while a *media element* is
 * actively playing — the engine's Web Audio graph alone is invisible to the
 * OS. So we anchor a silent, looping <audio> element and claim the session on
 * the first transport start (which is always a user gesture, satisfying
 * autoplay rules). From then on the OS routes media keys to our handlers.
 *
 * Action → transport mapping (no playlist concept, so track skips seek):
 *   play / pause / stop  → transportCommand(same)
 *   previoustrack        → rewind (jump to start)
 *   nexttrack            → stop  (end of "track")
 */
import type { appState as AppState } from '../state';

/** A 1s mono silent WAV as a blob URL — the media-session anchor source. */
function silentWavUrl(): string {
  const sampleRate = 8000;
  const samples = sampleRate; // 1 second
  const dataBytes = samples * 2; // 16-bit
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);
  // samples left at 0 = silence
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

/**
 * Wire hardware media keys to the transport. Returns a disposer that removes
 * the handlers and tears down the silent anchor.
 */
export function initMediaSession(state: typeof AppState): () => void {
  const ms = navigator.mediaSession;
  if (!ms) return () => undefined;

  const url = silentWavUrl();
  const anchor = new Audio(url);
  anchor.loop = true;
  anchor.volume = 0;
  // iOS Safari ignores muted+autoplay heuristics; volume 0 + loop is enough.

  let claimed = false;
  /** Start the silent anchor once, on a user-gesture-backed transport start. */
  const claim = () => {
    if (claimed) return;
    void anchor.play().then(() => {
      claimed = true;
    }).catch(() => undefined); // blocked until a real gesture — retry on next play
  };

  const handlers: [MediaSessionAction, () => void][] = [
    ['play', () => { state.transportCommand('play'); claim(); }],
    ['pause', () => state.transportCommand('pause')],
    ['stop', () => state.transportCommand('stop')],
    ['previoustrack', () => state.transportCommand('rewind')],
    ['nexttrack', () => state.transportCommand('stop')],
  ];
  for (const [action, fn] of handlers) {
    try {
      ms.setActionHandler(action, fn);
    } catch {
      // Browser doesn't support this action — skip it.
    }
  }

  ms.metadata = new MediaMetadata({
    title: state.projectName || 'KabelKraft',
    artist: 'KabelKraft',
  });

  // Mirror transport state to the OS widget + keep the anchor running so keys
  // keep flowing even when paused.
  const sync = () => {
    if (state.transport.playing) claim();
    ms.playbackState = state.transport.playing ? 'playing' : 'paused';
  };
  const offTransport = state.on('transportChanged', sync);
  const offMeta = state.on('projectMetaChanged', () => {
    ms.metadata = new MediaMetadata({
      title: state.projectName || 'KabelKraft',
      artist: 'KabelKraft',
    });
  });
  sync();

  return () => {
    offTransport();
    offMeta();
    for (const [action] of handlers) {
      try {
        ms.setActionHandler(action, null);
      } catch {
        // ignore
      }
    }
    ms.playbackState = 'none';
    anchor.pause();
    anchor.src = '';
    URL.revokeObjectURL(url);
  };
}
