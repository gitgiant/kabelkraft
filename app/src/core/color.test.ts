import { describe, expect, it } from 'vitest';
import { hexToRgbInt, hslToRgbInt, rgbIntToHex, rgbIntToHsl } from './color';

describe('color math', () => {
  it('converts primary hues to the expected RGB', () => {
    expect(hslToRgbInt(0, 1, 0.5)).toBe(0xff0000);
    expect(hslToRgbInt(1 / 3, 1, 0.5)).toBe(0x00ff00);
    expect(hslToRgbInt(2 / 3, 1, 0.5)).toBe(0x0000ff);
    expect(hslToRgbInt(0, 0, 1)).toBe(0xffffff);
    expect(hslToRgbInt(0.42, 0.7, 0)).toBe(0x000000);
  });

  it('round-trips HSL → RGB → HSL within tolerance', () => {
    for (const [h, s, l] of [[0.1, 0.8, 0.5], [0.62, 0.55, 0.35], [0.9, 1, 0.7]] as const) {
      const back = rgbIntToHsl(hslToRgbInt(h, s, l));
      expect(back.h).toBeCloseTo(h, 1);
      expect(back.s).toBeCloseTo(s, 1);
      expect(back.l).toBeCloseTo(l, 1);
    }
  });

  it('hue wraps outside 0–1', () => {
    expect(hslToRgbInt(1.25, 1, 0.5)).toBe(hslToRgbInt(0.25, 1, 0.5));
    expect(hslToRgbInt(-0.75, 1, 0.5)).toBe(hslToRgbInt(0.25, 1, 0.5));
  });

  it('hex round-trips', () => {
    expect(rgbIntToHex(0x3dd9ff)).toBe('#3dd9ff');
    expect(hexToRgbInt('#3dd9ff')).toBe(0x3dd9ff);
    expect(hexToRgbInt('garbage')).toBe(0);
  });
});
