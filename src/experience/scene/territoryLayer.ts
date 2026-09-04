/**
 * WAR experience — Territory layer (Phase A / A2).
 *
 * Draws each visible world's territory as a GPU primitive tinted by its REAL
 * Core mood (= state). No mood is invented; unknown/absent state falls back to
 * the neutral UNKNOWN tone. Zero intelligence, zero classification.
 */

import { Container, Graphics } from "pixi.js";
import type { RenderFrame } from "../../world/worldRenderer.js";
import type { QualityBudget } from "../adaptiveQuality.js";
import type { SceneLayer } from "./layer.js";
import { moodTone, PALETTE } from "../visual/vocabulary.js";

export class TerritoryLayer implements SceneLayer {
  readonly name = "territory";
  readonly view = new Container();
  private readonly nodes = new Map<string, Graphics>();

  update(frame: RenderFrame, _budget: QualityBudget): void {
    const seen = new Set<string>();

    for (const inst of frame.instances) {
      seen.add(inst.id);
      const g = this.ensure(inst.id);
      g.position.set(inst.position.x, inst.position.y);

      // Radius grows a little with LOD so focused worlds read larger. Purely
      // presentational; carries no data meaning.
      const radius = 18 + inst.lod * 10;
      const tone = inst.state ? moodTone(inst.state.mood) : PALETTE.neutral;

      g.clear();
      g.circle(0, 0, radius).fill({ color: tone, alpha: 0.14 });
      g.circle(0, 0, radius).stroke({ color: tone, width: 1.5, alpha: 0.9 });
    }

    // Cull nodes no longer visible (streaming): release their GPU objects.
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
