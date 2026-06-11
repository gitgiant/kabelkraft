import { expect, test } from '@playwright/test';
import { bootWithAudio, peakOf, pollControl, pollPeak, pollPeakUntil } from './util';

/** Mod Matrix: control routing in1 → out1 scales with the m11 depth. */

test('mod matrix routes a knob to a filter cutoff with adjustable depth', async ({ page }) => {
  await bootWithAudio(page);

  const ids = await page.evaluate(() => {
    const s = window.__kk;
    const out = [...s.graph.modules.values()].find((m) => m.type === 'audioOut')!;
    const osc = s.addModule('osc', 0, 0);
    const vcf = s.addModule('vcf', 200, 0);
    const knob = s.addModule('knob', 0, 200);
    const mm = s.addModule('modmatrix', 100, 200);
    s.connect({ moduleId: osc.id, portId: 'out' }, { moduleId: vcf.id, portId: 'in' });
    s.connect({ moduleId: vcf.id, portId: 'out' }, { moduleId: out.id, portId: 'in' });
    s.connect({ moduleId: knob.id, portId: 'out' }, { moduleId: mm.id, portId: 'in1' });
    s.connect({ moduleId: mm.id, portId: 'out1' }, { moduleId: vcf.id, portId: 'mod' });
    s.setParam(vcf.id, 'cutoff', 200);
    s.setParam(vcf.id, 'amt', 6);
    s.setParam(knob.id, 'value', 1);
    return { vcf: vcf.id, knob: knob.id, mm: mm.id };
  });

  // Depth 0 (default): matrix passes nothing — filter stays (nearly) closed.
  await pollPeak(page, ids.vcf, 0.0005);
  const closed = await peakOf(page, ids.vcf);

  // Full positive depth: knob value reaches the cutoff mod input…
  await page.evaluate((i) => window.__kk.setParam(i.mm, 'm11', 1), ids);
  await pollControl(page, ids.mm).toBeGreaterThan(0.99);

  // …and +6 octaves of cutoff passes much more energy. Poll the relation
  // itself instead of sleeping and reading once.
  await pollPeakUntil(page, ids.vcf, (peak) => peak > closed * 1.5);
});
