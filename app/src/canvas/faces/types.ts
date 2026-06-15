import type { ModuleView } from '../ModuleView';

/**
 * Renders one module type's tile face. A FaceRenderer is created per view (so
 * it may hold per-instance redraw state, e.g. the response-curve Graphics) and
 * is handed the whole ModuleView — it calls the view's face API (buildKnob,
 * paramCtrl, …) to lay itself out. See CONTEXT.md "Face-rendering seam".
 */
export interface FaceRenderer {
  build(view: ModuleView): void;
  /** Redraw live visuals (curves, meters) on a param change. */
  refresh?(view: ModuleView): void;
  /** A sample/wavetable finished loading for this module — redraw waveforms. */
  refreshSample?(view: ModuleView): void;
  /** Per-frame update from worklet state (playheads, meters, spectra). */
  live?(view: ModuleView): void;
}

/**
 * Per-type face entry. A migrated face supplies `make()` (its own renderer
 * object); faces still living on ModuleView supply `build`/`refresh` arrows
 * that delegate to its methods. The flags replace the old sizing Sets.
 */
export interface FaceDef {
  make?: () => FaceRenderer;
  build?: (view: ModuleView) => void;
  refresh?: (view: ModuleView) => void;
  /** Hand-tuned layout that should not auto-fit to a param grid. */
  customLayout?: boolean;
  /** No upper size cap (hosts nested editors/canvases). */
  unbounded?: boolean;
  /** Cannot shrink below the def's default size. */
  fixedMin?: boolean;
}
