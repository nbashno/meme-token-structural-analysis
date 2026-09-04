/**
 * WAR experience — World layer (Phase A / A2, B3).
 *
 * Draws each world's "core" plus its battlefield seam. The seam is a purely
 * geometric split of a shared bar using the EXISTING WorldState.power.raw and
 * WorldState.threat.raw. It computes NO new ratio/score/advantage — see
 * battlefieldSeam.ts. Worlds without state draw a neutral placeholder.
 */

import { Container, Graphics } from "pixi.js";
import type { RenderFrame } from "../../world/worldRenderer.js";
import type { QualityBudget } from "../adaptiveQuality.js";
import type { SceneLayer } from "./layer.js";
import { seamGeometry } from "../visual/battlefieldSeam.js";
import { PALETTE } from "../visual/vocabulary.js";

const BAR_W = 44;
const BAR_H = 5;

export class WorldLayer implements SceneLayer {
  readonly name = "world";
  readonly view = new Container();
  private readonly nodes = new Map<string, Graphics>();

  update(frame: RenderFrame, _budget: QualityBudget): void {
    const seen = new Set<string>();

    for (const inst of frame.instances) {
      seen.add(inst.id);
      const g = this.ensure(inst.id);
      g.position.set(inst.position.x, inst.position.y);
      g.clear();

      // Core dot.
      g.circle(0, 0, 4).fill({ color: PALETTE.ink, alpha: 0.9 });

      // Battlefield seam only at LOD >= 1 (readable zoom). Presentation gate.
      if (inst.lod >= 1 && inst.state) {
        const seam = seamGeometry(inst.state.power.raw, inst.state.threat.raw);
        const left = -BAR_W / 2;
        const y = 12;
        const split = left + seam.seam01 * BAR_W;

        // Power side (left of seam).
        g.rect(left, y, split - left, BAR_H).fill({ color: seam.powerColor, alpha: 0.85 });
        // Threat side (right of seam).
        g.rect(split, y, left + BAR_W - split, BAR_H).fill({ color: seam.threatColor, alpha: 0.85 });
        // The contested seam marker.
        g.rect(split - 0.5, y - 2, 1, BAR_H + 4).fill({ color: PALETTE.ink, alpha: 1 });
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
