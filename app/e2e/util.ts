import type { Page } from '@playwright/test';

export interface ClassicRig {
  sequencer: string;
  keyboard: string;
  /** Audio source / final voice stage — the VCA. Back-compat alias used by most specs. */
  synth: string;
  voice: string;
  osc: string;
  vcf: string;
  vca: string;
  adsr: string;
  lfo: string;
  out: string;
  levels: string;
}

/**
 * The classic test rig, rebuilt from components (the monolithic synth is gone):
 * sequencer + keyboard → voice → osc → vcf → vca → audioOut + levels, with an
 * amp ADSR on the VCA and an LFO on the filter. `synth` aliases the VCA (the
 * final audio stage feeding the output), so specs that splice effects after the
 * "synth" or read its meter/level still work; specs that need a filter cutoff
 * use `vcf`.
 */
export async function classicRig(page: Page): Promise<ClassicRig> {
  return page.evaluate(() => {
    const s = window.__kk;
    for (const g of [...s.graph.groups.keys()]) s.ungroup(g);
    for (const m of [...s.graph.modules.values()]) s.removeModule(m.id);
    s.addModule('transport', -150, -300);
    const sequencer = s.addModule('sequencer', -980, -220);
    const keyboard = s.addModule('keyboard', -980, 120);
    const voice = s.addModule('voice', -680, -120);
    const osc = s.addModule('osc', -360, -260);
    const adsr = s.addModule('adsr', -680, 220);
    // lfo sits just under the vcf: faces.spec groups vcf+lfo and expands it, so
    // the pair must stay compact and on-screen for param hit-testing.
    const lfo = s.addModule('lfo', -40, 200);
    const vcf = s.addModule('vcf', -40, -200);
    const vca = s.addModule('vca', 320, -60);
    const out = s.addModule('audioOut', 640, 40);
    const levels = s.addModule('levels', 640, 320);
    const wire = (f: string, fp: string, t: string, tp: string) =>
      s.connect({ moduleId: f, portId: fp }, { moduleId: t, portId: tp });
    wire(sequencer.id, 'notes', voice.id, 'notes');
    wire(keyboard.id, 'notes', voice.id, 'notes');
    wire(voice.id, 'pitch', osc.id, 'pitch');
    wire(voice.id, 'gate', adsr.id, 'gate');
    wire(osc.id, 'out', vcf.id, 'in');
    wire(lfo.id, 'out', vcf.id, 'mod');
    wire(vcf.id, 'out', vca.id, 'in');
    wire(adsr.id, 'out', vca.id, 'cv');
    wire(vca.id, 'out', out.id, 'in');
    wire(vca.id, 'out', levels.id, 'in');
    return {
      sequencer: sequencer.id,
      keyboard: keyboard.id,
      synth: vca.id,
      voice: voice.id,
      osc: osc.id,
      vcf: vcf.id,
      vca: vca.id,
      adsr: adsr.id,
      lfo: lfo.id,
      out: out.id,
      levels: levels.id,
    };
  });
}
