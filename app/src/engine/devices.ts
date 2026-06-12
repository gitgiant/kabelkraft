/**
 * Audio device discovery shared by Options → Audio and the Audio In module.
 *
 * Browsers hide device labels (and often everything beyond the defaults)
 * until a getUserMedia permission has been granted, so discovery is a
 * two-step dance: ensureAudioPermission() once, then enumerate freely.
 */

export interface AudioDeviceInfo {
  deviceId: string;
  label: string;
}

export interface AudioDeviceLists {
  inputs: AudioDeviceInfo[];
  outputs: AudioDeviceInfo[];
}

let permissionGranted = false;

/** Whether a capture grant is already in place (labels will be populated). */
export function audioPermissionGranted(): boolean {
  return permissionGranted;
}

/**
 * Prompt for (or silently confirm) microphone access, then immediately stop
 * the probe stream — we only need the grant so enumerateDevices() returns
 * the full device list with labels. Returns false when denied/unavailable.
 */
export async function ensureAudioPermission(): Promise<boolean> {
  if (permissionGranted) return true;
  if (!navigator.mediaDevices?.getUserMedia) return false;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    permissionGranted = true;
    return true;
  } catch {
    return false;
  }
}

/** Enumerate audio devices; labels are blank until ensureAudioPermission(). */
export async function listAudioDevices(): Promise<AudioDeviceLists> {
  if (!navigator.mediaDevices?.enumerateDevices) return { inputs: [], outputs: [] };
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    // The permission probe may have happened elsewhere (e.g. an earlier
    // getUserMedia for an Audio In stream) — labels present means granted.
    if (devices.some((d) => d.kind === 'audioinput' && d.label)) permissionGranted = true;
    const named = (d: MediaDeviceInfo, i: number, kind: string) => ({
      deviceId: d.deviceId,
      label: d.label || `${kind} ${i + 1}`,
    });
    return {
      inputs: devices
        .filter((d) => d.kind === 'audioinput')
        .map((d, i) => named(d, i, 'Input')),
      outputs: devices
        .filter((d) => d.kind === 'audiooutput')
        .map((d, i) => named(d, i, 'Output')),
    };
  } catch {
    return { inputs: [], outputs: [] };
  }
}

/** Subscribe to hot-plug events; returns an unsubscribe. */
export function onDeviceChange(fn: () => void): () => void {
  const md = navigator.mediaDevices;
  if (!md?.addEventListener) return () => undefined;
  md.addEventListener('devicechange', fn);
  return () => md.removeEventListener('devicechange', fn);
}
