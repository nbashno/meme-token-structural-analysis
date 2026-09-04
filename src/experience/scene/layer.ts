/**
 * WAR experience — scene layer contract (Phase A / A2).
 *
 * Every visual layer is a presentation unit that consumes an already-projected
 * RenderFrame and draws it. Layers NEVER compute intelligence and NEVER read
 * Core/Product/GMGN. They read only RenderFrame (which carries WorldState).
 *
 * Kept renderer-library-agnostic at the type level: a layer owns a Pixi
 * Container internally, but the contract here exposes only lifecycle + update.
 */

import type { Container } from "pixi.js";
import type { RenderFrame } from "../../world/worldRenderer.js";
import type { QualityBudget } from "../adaptiveQuality.js";

export interface SceneLayer {
  readonly name: string;
  /** The Pixi container this layer manages (added to the scene by ArenaScene). */
  readonly view: Container;
  /** Redraw from the current frame + quality budget. Presentation only. */
  update(frame: RenderFrame, budget: QualityBudget): void;
  /** Release GPU resources deterministically. */
  destroy(): void;
}
