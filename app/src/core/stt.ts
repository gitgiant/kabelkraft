/**
 * Speech-to-text manager (Web Speech API) — one recognizer per Speech-to-Text
 * module. Interim results stream while talking (karaoke feel); Chrome ends
 * sessions after silence, so active recognizers auto-restart until stopped.
 * Native path (whisper.cpp) comes later; this is the browser tier.
 */

// Minimal ambient typings — lib.dom still ships SpeechRecognition unprefixed
// in some configs only.
interface SpeechAlternativeLike {
  transcript: string;
}
interface SpeechResultLike {
  isFinal: boolean;
  0: SpeechAlternativeLike;
}
interface SpeechResultEventLike {
  resultIndex: number;
  results: { length: number; [i: number]: SpeechResultLike };
}
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: SpeechResultEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  start(): void;
  stop(): void;
}

type SttCallback = (text: string, final: boolean) => void;

function recognitionCtor(): (new () => SpeechRecognitionLike) | null {
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as
    | (new () => SpeechRecognitionLike)
    | null;
}

export class SttManager {
  private recs = new Map<string, SpeechRecognitionLike>();

  supported(): boolean {
    return typeof window !== 'undefined' && recognitionCtor() !== null;
  }

  active(moduleId: string): boolean {
    return this.recs.has(moduleId);
  }

  /** Returns false when the API is unavailable or the mic refuses to start. */
  start(moduleId: string, onResult: SttCallback): boolean {
    if (this.recs.has(moduleId)) return true;
    const Ctor = recognitionCtor();
    if (!Ctor) return false;
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const text = r[0]?.transcript.trim();
        if (text) onResult(text, r.isFinal);
      }
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') this.stop(moduleId);
    };
    rec.onend = () => {
      // Browser ended the session (silence timeout) — keep listening.
      if (this.recs.get(moduleId) === rec) {
        try {
          rec.start();
        } catch {
          this.recs.delete(moduleId);
        }
      }
    };
    try {
      rec.start();
    } catch {
      return false;
    }
    this.recs.set(moduleId, rec);
    return true;
  }

  stop(moduleId: string): void {
    const rec = this.recs.get(moduleId);
    if (!rec) return;
    this.recs.delete(moduleId); // delete first so onend doesn't restart
    try {
      rec.stop();
    } catch {
      /* already stopped */
    }
  }

  /** Stop recognizers whose modules were deleted. */
  prune(liveIds: ReadonlySet<string>): void {
    for (const id of [...this.recs.keys()]) if (!liveIds.has(id)) this.stop(id);
  }
}
