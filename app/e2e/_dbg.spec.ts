import { test } from '@playwright/test';
import { bootWithAudio, classicRig, play } from './util';

test('dbg', async ({ page }) => {
  page.on('console', (m) => console.log('PAGE:', m.text()));
  await bootWithAudio(page);
  const rig = await classicRig(page);
  const ids = await page.evaluate(({ synth }) => {
    const s = window.__kk;
    const c = (window as any).__kkCanvas;
    const pos = c.viewCenter();
    const a = s.addModule('visualizer', pos.x + 1100, pos.y + 350);
    const b = s.addModule('visualizer', pos.x + 1500, pos.y);
    s.connect({ moduleId: synth, portId: 'out' }, { moduleId: a.id, portId: 'in' });
    s.connect({ moduleId: a.id, portId: 'vout' }, { moduleId: b.id, portId: 'vin' });
    s.setVisGraph(b.id, {
      nodes: [
        { id: 'v1', type: 'visualin', x: 40, y: 60, params: {} },
        { id: 'v2', type: 'output', x: 240, y: 60, params: {} },
      ],
      wires: [{ id: 'w1', from: { nodeId: 'v1', portId: 'out' }, to: { nodeId: 'v2', portId: 'in' } }],
    });
    return { a: a.id, b: b.id };
  }, { synth: rig.synth });
  await play(page);
  await page.waitForTimeout(800);
  const info = await page.evaluate(async ({ a, b }) => {
    const s = window.__kk;
    const fb = s.visFrame(b)!;
    const fa = s.visFrame(a)!;
    const fA = s.visFeatures(a);
    // sample overlay canvas pixels for A alone first
    const sample = async (id: string) => {
      const c = (window as any).__kkCanvas;
      const p = c.clientPointFor(id)!;
      c.panBy(450 - p.x, 200 - p.y);
      s.openVisualizer(id);
      await new Promise((r) => setTimeout(r, 700));
      const canvas = document.querySelector('.vis-overlay canvas') as HTMLCanvasElement;
      const probe = document.createElement('canvas');
      probe.width = canvas.width; probe.height = canvas.height;
      const ctx = probe.getContext('2d')!;
      ctx.drawImage(canvas, 0, 0);
      const d = ctx.getImageData(0, 0, probe.width, probe.height).data;
      let bright = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] + d[i+1] + d[i+2] > 90) bright++;
      s.closeVisualizer();
      return bright;
    };
    const brightA = await sample(a);
    const brightB = await sample(b);
    return {
      brightA, brightB,
      upstreamOfB: fb.upstream.map((u) => u.id),
      aNodes: fa.graph.nodes.map((n) => n.type),
      aPeak: fA?.peak ?? -1,
    };
  }, ids);
  console.log(JSON.stringify(info));
});
