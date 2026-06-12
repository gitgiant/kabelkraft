import { expect, test } from '@playwright/test';
import { boot } from './util';

const PROJECT = JSON.stringify({
  kind: 'kkproject',
  formatVersion: 1,
  name: 'E2E Song',
  tempo: 96,
  modules: [
    {
      id: 'comp',
      type: 'composer',
      data: { length: 8, notes: [{ start: 0, length: 1, pitch: 48, vel: 0.9 }] },
    },
    { id: 'v', type: 'voice', params: { voices: 1 } },
    { id: 's', type: 'osc', params: { wave: 3, level: 0.6 } },
    { id: 'mix', type: 'mixer' },
    { id: 'out', type: 'audioOut' },
  ],
  wires: [
    { from: { module: 'comp', port: 'notes' }, to: { module: 'v', port: 'notes' } },
    { from: { module: 'v', port: 'pitch' }, to: { module: 's', port: 'pitch' } },
    { from: { module: 's', port: 'out' }, to: { module: 'mix', port: 'in1' } },
    { from: { module: 'mix', port: 'out' }, to: { module: 'out', port: 'in' } },
  ],
  groups: [
    {
      id: 'bass',
      name: 'Bass',
      modules: ['comp', 'v', 's'],
      groups: [],
      face: {
        width: 280,
        height: 160,
        elements: [
          { kind: 'label', x: 12, y: 4, text: 'BASS' },
          { kind: 'knob', x: 12, y: 28, label: 'Wave', module: 's', param: 'wave' },
        ],
      },
    },
    { id: 'master', name: 'Master', modules: ['mix', 'out'], groups: ['bass'] },
  ],
});

test('AI project dialog: paste, replace project, nested groups + tempo land', async ({ page }) => {
  await boot(page);

  // Accept the replace-project confirm.
  page.on('dialog', (d) => d.accept());

  await page.locator('.ai-project-toggle').click();
  await expect(page.locator('.ai-dialog')).toBeVisible();
  await expect(page.locator('.ai-title')).toHaveText('AI Project');
  await page.locator('.ai-dialog textarea').fill(PROJECT);
  await page.locator('.ai-dialog button.import').click();
  await expect(page.locator('.ai-dialog .success')).toBeVisible();

  const after = await page.evaluate(() => {
    const s = window.__kk;
    const groups = [...s.graph.groups.values()];
    const master = groups.find((g) => g.name === 'Master');
    const bass = groups.find((g) => g.name === 'Bass');
    const comp = [...s.graph.modules.values()].find((m) => m.type === 'composer');
    const osc = [...s.graph.modules.values()].find((m) => m.type === 'osc');
    const knob = bass?.face?.elements.find((e) => e.kind === 'knob');
    return {
      name: s.projectName,
      tempo: s.transport.tempo,
      modules: s.graph.modules.size,
      wires: s.graph.wires.size,
      groups: groups.length,
      nested: !!master && !!bass && master.groupIds.includes(bass.id),
      clipNotes: (comp?.data?.notes as unknown[] | undefined)?.length ?? 0,
      faceElements: bass?.face?.elements.length ?? 0,
      // Binding remapped from the project's own id "s" to the real instance id.
      knobBound: !!knob && knob.moduleId === osc?.id && knob.paramId === 'wave',
    };
  });
  expect(after.name).toBe('E2E Song');
  expect(after.tempo).toBe(96);
  expect(after.modules).toBe(5);
  expect(after.wires).toBe(4);
  expect(after.groups).toBe(2);
  expect(after.nested).toBe(true);
  expect(after.clipNotes).toBe(1);
  expect(after.faceElements).toBe(2);
  expect(after.knobBound).toBe(true);
});

test('bad project shows readable errors, nothing replaced', async ({ page }) => {
  await boot(page);

  const before = await page.evaluate(() => ({
    modules: window.__kk.graph.modules.size,
    name: window.__kk.projectName,
  }));

  await page.locator('.ai-project-toggle').click();
  await page
    .locator('.ai-dialog textarea')
    .fill(JSON.stringify({ kind: 'kkproject', modules: [{ id: 'a', type: 'superSaw' }] }));
  await page.locator('.ai-dialog button.import').click();

  await expect(page.locator('.ai-dialog .errors')).toBeVisible();
  await expect(page.locator('.ai-dialog .errors')).toContainText('superSaw');
  const after = await page.evaluate(() => ({
    modules: window.__kk.graph.modules.size,
    name: window.__kk.projectName,
  }));
  expect(after).toEqual(before);
});

test('grouping inside a group nests (encapsulation)', async ({ page }) => {
  await boot(page);

  const result = await page.evaluate(() => {
    const s = window.__kk;
    const a = s.addModule('osc', 0, 0);
    const b = s.addModule('vcf', 300, 0);
    const c = s.addModule('vca', 600, 0);
    s.clearSelection();
    s.addToSelection({ moduleId: a.id });
    s.addToSelection({ moduleId: b.id });
    s.addToSelection({ moduleId: c.id });
    const outer = s.groupSelection()!;
    // Select two members INSIDE the group and group again → nested child.
    s.clearSelection();
    s.addToSelection({ moduleId: a.id });
    s.addToSelection({ moduleId: b.id });
    const inner = s.groupSelection();
    const outerGroup = s.graph.groups.get(outer)!;
    return {
      inner,
      nested: inner ? outerGroup.groupIds.includes(inner) : false,
      outerModules: outerGroup.moduleIds.length,
      innerModules: inner ? s.graph.groups.get(inner)!.moduleIds.length : 0,
    };
  });
  expect(result.inner).not.toBeNull();
  expect(result.nested).toBe(true);
  expect(result.outerModules).toBe(1); // c stays; a+b moved into the child
  expect(result.innerModules).toBe(2);
});
