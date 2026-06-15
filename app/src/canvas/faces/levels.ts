import { MODULE_TITLE_H, type ModuleView } from '../ModuleView';
import type { VMeter } from './meters';
import type { FaceRenderer } from './types';

/** Levels: a single centered vertical peak meter, driven from live(). */
export class LevelsFace implements FaceRenderer {
  private meter: VMeter | null = null;

  build(view: ModuleView): void {
    this.meter = view.buildVMeter(view.w / 2 - 12, MODULE_TITLE_H + 18, 24, view.h - MODULE_TITLE_H - 32);
  }

  live(view: ModuleView): void {
    this.meter?.update(view);
  }
}
