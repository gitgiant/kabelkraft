/**
 * Color math for the dynamic tint system (frame-derived UI tints).
 * Colors travel as packed 24-bit RGB ints; adjustments happen in HSL.
 */

/** HSL (all 0–1) → packed 24-bit RGB. */
export function hslToRgbInt(h: number, s: number, l: number): number {
  const hh = ((h % 1) + 1) % 1;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + hh * 12) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return (
    (Math.round(f(0) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(4) * 255)
  );
}

/** Packed 24-bit RGB → HSL (all 0–1). */
export function rgbIntToHsl(rgb: number): { h: number; s: number; l: number } {
  const r = ((rgb >> 16) & 0xff) / 255;
  const g = ((rgb >> 8) & 0xff) / 255;
  const b = (rgb & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h /= 6;
  if (h < 0) h += 1;
  return { h, s, l };
}

/** Packed RGB → '#rrggbb' for DOM color inputs. */
export function rgbIntToHex(rgb: number): string {
  return `#${rgb.toString(16).padStart(6, '0')}`;
}

/** '#rrggbb' → packed RGB (NaN-safe: falls back to 0). */
export function hexToRgbInt(hex: string): number {
  const v = parseInt(hex.replace('#', ''), 16);
  return Number.isFinite(v) ? v & 0xffffff : 0;
}
