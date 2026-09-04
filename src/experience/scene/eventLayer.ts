/**
 * WAR experience — Event layer (Phase A / A2, B5).
 *
 * Existing WorldState.events become pulses whose alpha reflects the event's
 * ALREADY-COMPUTED importance. No event is re-classified and no new event is
 * synthesized. If there are no events, nothing is drawn (honest emptiness).
 */

import { Container, Graphics } from "pixi.js";
import type { RenderFrame } from "../../world/worldRenderer.js";
import type { QualityBudget } from "../adaptiveQuality.js";
import type { SceneLayer } from "./layer.js";
import { eventPulseAlpha, PALETTE } from "../visual/vocabulary.js";

export class EventLayer implements SceneLayer {
  readonly name = "event";
  readonly view = new Container();
  private readonly nodes = new Map<string, Graphics>();

  update(frame: RenderFrame, _budget: QualityBudget): void {
    const seen = new Set<string>();

    for (const inst of frame.instances) {
      if (inst.lod < 1 || !inst.state || inst.state.events.length === 0) continue;
      seen.add(inst.id);
      const g = this.ensure(inst.id);
      g.position.set(inst.position.x, inst.position.y);
      g.clear();

      // Strongest event drives the pulse ring; importance is passed through.
      let maxImportance = 0;
      for (const e of inst.state.events) {
        if (e.importance > maxImportance) maxImportance = e.importance;
      }
      const alpha = eventPulseAlpha(maxImportance);
      if (alpha > 0) {
        g.circle(0, 0, 22).stroke({ color: PALETTE.attention, width: 2, alpha });
      }
    }

    for (const [id, g] of this.nodes) {
      if (!seen.has(id)) {
        g.destroy();
        this.nodes.delete(id);
      }
    }
  }

  private ensure(id: string): Graphics {
    let g = this.nodes.get(id);
    if (!g) {
      g = new Graphics();
      this.nodes.set(id, g);
      this.view.addChild(g);
    }
    return g;
  }

  destroy(): void {
    for (const g of this.nodes.values()) g.destroy();
    this.nodes.clear();
    this.view.destroy({ children: true });
  }
}
