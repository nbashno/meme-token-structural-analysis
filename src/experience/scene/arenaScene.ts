/**
 * WAR experience — ArenaScene (Phase A / A2).
 *
 * Composes the presentation layers and applies the camera transform to the
 * world container. Layers are drawn in a fixed z-order. The scene consumes a
 * RenderFrame + quality budget and forwards them to each layer. It holds no
 * intelligence and no data of its own.
 *
 * Layer order (back → front):
 *   territory → world(core+seam) → flow → event → selection
 * (a ParticleLayer slot exists conceptually inside flow/event for now; a
 *  dedicated GPU ParticleContainer layer is a B-phase refinement.)
 */

import { Container } from "pixi.js";
import type { RenderFrame } from "../../world/worldRenderer.js";
import type { QualityBudget } from "../adaptiveQuality.js";
import type { SceneLayer } from "./layer.js";
import { TerritoryLayer } from "./territoryLayer.js";
import { WorldLayer } from "./worldLayer.js";
import { FlowLayer } from "./flowLayer.js";
import { EventLayer } from "./eventLayer.js";
import { SelectionLayer } from "./selectionLayer.js";

export class ArenaScene {
  /** Root container; the renderer adds this to the Pixi stage. */
  readonly root = new Container();
  /** World-space container the camera transform is applied to. */
  private readonly world = new Container();
  private readonly layers: readonly SceneLayer[];

  constructor() {
    this.layers = [
      new TerritoryLayer(),
      new WorldLayer(),
      new FlowLayer(),
      new EventLayer(),
      new SelectionLayer(),
    ];
    for (const layer of this.layers) this.world.addChild(layer.view);
    this.root.addChild(this.world);
  }

  /** Apply camera + redraw every layer from the current frame. */
  update(frame: RenderFrame, budget: QualityBudget, viewport: { width: number; height: number }): void {
    // Camera: translate so (camera.x, camera.y) is centered, then zoom.
    const { camera } = frame;
    this.world.scale.set(camera.zoom, camera.zoom);
    this.world.position.set(
      viewport.width / 2 - camera.x * camera.zoom,
      viewport.height / 2 - camera.y * camera.zoom,
    );
    for (const layer of this.layers) layer.update(frame, budget);
  }

  destroy(): void {
    for (const layer of this.layers) layer.destroy();
    this.world.destroy({ children: true });
    this.root.destroy({ children: true });
  }
}
