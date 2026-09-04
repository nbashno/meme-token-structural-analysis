/**
 * WAR experience — Selection layer (Phase A / A2).
 *
 * Draws the selection ring around the focused world and an attention ring whose
 * radius reflects the REAL, already-computed attention value. No selection logic
 * lives here beyond "is this instance the focusedId in the frame". No data made.
 */

import { Container, Graphics } from "pixi.js";
import type { RenderFrame } from "../../world/worldRenderer.js";
import type { QualityBudget } from "../adaptiveQuality.js";
import type { SceneLayer } from "./layer.js";
import { attentionRadius, PALETTE } from "../visual/vocabulary.js";

export class SelectionLayer implements SceneLayer {
  readonly name = "selection";
  readonly view = new Container();
  private readonly ring = new Graphics();

  constructor() {
    this.view.addChild(this.ring);
  }

  update(frame: RenderFrame, _budget: QualityBudget): void {
    this.ring.clear();
    if (frame.focusedId == null) return;

    const focused = frame.instances.find((i) => i.id === frame.focusedId);
    if (!focused) return;

    this.ring.position.set(focused.position.x, focused.position.y);

    // Selection ring (constant, presentational).
    this.ring.circle(0, 0, 30).stroke({ color: PALETTE.ink, width: 2, alpha: 0.9 });

    // Attention ring — radius from the real attention value.
    if (focused.state) {
      const r = attentionRadius(focused.state.attention.raw);
      this.ring.circle(0, 0, r).stroke({ color: PALETTE.attention, width: 1, alpha: 0.5 });
    }
  }

  destroy(): void {
    this.ring.destroy();
    this.view.destroy({ children: true });
  }
}
