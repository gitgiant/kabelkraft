import type { Page } from '@playwright/test';

export interface ClassicRig {
  sequencer: string;
  keyboard: string;
  synth: string;
  lfo: string;
  out: string;
  levels: string;
}

/**
 * The classic test rig (the pre-component starter patch): sequencer +
 * keyboard → synth (LFO on pitchMod) → audioOut + levels. Many specs were
 * written against this shape, so they rebuild it instead of relying on the
 * shipping starter patch (now the component-based Poly Synth group).
 */
export async function classicRig(page: Page): Promise<ClassicRig> {
  return page.evaluate(() => {
    const s = window.__kk;
    for (const g of [...s.graph.groups.keys()]) s.ungroup(g);
    for (const m of [...s.graph.modules.values()]) s.removeModule(m.id);
    s.addModule('transport', -150, -300);
    const sequencer = s.addModule('sequencer', -540, -160);
    const keyboard = s.addModule('keyboard', -510, 60);
    const synth = s.addModule('synth', -120, -40);
    const lfo = s.addModule('lfo', -380, 220);
    const out = s.addModule('audioOut', 220, 0);
    const levels = s.addModule('levels', 220, 160);
    const wire = (f: string, fp: string, t: string, tp: string) =>
      s.connect({ moduleId: f, portId: fp }, { moduleId: t, portId: tp });
    wire(sequencer.id, 'notes', synth.id, 'notes');
    wire(keyboard.id, 'notes', synth.id, 'notes');
    wire(lfo.id, 'out', synth.id, 'pitchMod');
    wire(synth.id, 'out', out.id, 'in');
    wire(synth.id, 'out', levels.id, 'in');
    s.setParam(synth.id, 'pmAmt', 0.3);
    return {
      sequencer: sequencer.id,
      keyboard: keyboard.id,
      synth: synth.id,
      lfo: lfo.id,
      out: out.id,
      levels: levels.id,
    };
  });
}
