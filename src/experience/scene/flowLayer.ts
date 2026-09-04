/**
 * WAR experience — Flow layer (Phase A / A2, B4).
 *
 * Turns EXISTING flow observations (WorldState.flowEntities) into GPU streams,
 * tinted only by the provenance lane that actually exists in the data:
 *   SMART_MONEY · KOL · FOLLOW_WALLET · OTHER.
 *
 * It NEVER invents sniper / whale / hunter / insider / dev personas — the
 * FlowEntityView.persona is always UNKNOWN in Phase 1 and this layer respects
 * that. Buy/sell is passed through, never re-classified.
 */

import { Container, Graphics } from "pixi.js";
import type { RenderFrame } from "../../world/worldRenderer.js";
import type { QualityBudget } from "../adaptiveQuality.js";
import type { SceneLayer } from "./layer.js";
import { laneTint } from "../visual/vocabulary.js";

export class FlowLayer implements SceneLayer {
  readonly name = "flow";
  readonly view = new Container();
  private readonly nodes = new Map<string, Graphics>();

  update(frame: RenderFrame, budget: QualityBudget): void {
    const seen = new Set<string>();

    for (const inst of frame.instances) {
      // Flow detail only when focused enough and quality allows secondary effects.
      if (inst.lod < 2 || !inst.state || !budget.secondaryEffects) continue;
      seen.add(inst.id);
      const g = this.ensure(inst.id);
      g.position.set(inst.position.x, inst.position.y);
      g.clear();

      const entities = inst.state.flowEntities.slice(0, budget.particlesPerWorld);
      entities.forEach((e, i) => {
        const tint = laneTint(e.lane);
        // Buys arc up-left, sells arc down-right. Direction is a passed-through
        // fact (e.side), not a computed signal.
        const dir = e.side === "buy" ? -1 : 1;
        const angle = (i / Math.max(1, entities.length)) * Math.PI - Math.PI / 2;
        const r = 26 + (i % 4) * 3;
        const x = Math.cos(angle) * r;
        const y = Math.sin(angle) * r * dir;
        g.circle(x, y, 1.6).fill({ color: tint, alpha: 0.8 });
      });
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
