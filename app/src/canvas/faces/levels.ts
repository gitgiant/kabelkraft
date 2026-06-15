import { MODULE_TITLE_H, type ModuleView } from '../ModuleView';
import type { FaceRenderer } from './types';

/** Levels: a single centered vertical peak meter (live update is the shared
 * meterBar path in ModuleView.updateLive). */
export class LevelsFace implements FaceRenderer {
  build(view: ModuleView): void {
    view.buildVMeter(view.w / 2 - 12, MODULE_TITLE_H + 18, 24, view.h - MODULE_TITLE_H - 32);
  }
}
