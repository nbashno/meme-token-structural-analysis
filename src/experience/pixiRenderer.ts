/**
 * WAR experience — PixiRenderer (Phase A / A1).
 *
 * A concrete implementation of the EXISTING `WorldRenderer` contract
 * (src/world/worldRenderer.ts) backed by PixiJS 8. It:
 *   - detects WebGPU and falls back to WebGL2 (never claims WebGPU blindly)
 *   - owns a clean lifecycle (init / resize / device-loss note / destroy)
 *   - draws ONLY the RenderFrame it is given (already-projected data)
 *
 * It imports NOTHING from Core/Product/GMGN and computes NO intelligence.
 * Pixi-specific objects never leak outward: the outward contract is WorldRenderer.
 */

import { Application, type ApplicationOptions } from "pixi.js";
import type { RenderFrame, WorldRenderer } from "../world/worldRenderer.js";
import { ArenaScene } from "./scene/arenaScene.js";
import { detectFromWindow, type Capability } from "./capability.js";
import {
  adaptTier,
  budgetFor,
  FrameMeter,
  type QualityTier,
} from "./adaptiveQuality.js";

export interface PixiRendererOptions {
  /** Start tier; adapts from measured frame time thereafter. */
  readonly initialTier?: QualityTier;
  /** Override capability detection (tests / forced fallback). */
  readonly capability?: Capability;
}

export class PixiRenderer implements WorldRenderer {
  readonly name = "pixi" as const;

  private app: Application | null = null;
  private scene: ArenaScene | null = null;
  private readonly meter = new FrameMeter(30);
  private tier: QualityTier;
  private capability: Capability;
  private lastFrameStamp: number | null = null;
  private canvasEl: HTMLCanvasElement | null = null;

  constructor(options: PixiRendererOptions = {}) {
    this.tier = options.initialTier ?? "HIGH";
    this.capability = options.capability ?? detectFromWindow();
  }

  /** Read-only capability verdict for the HUD/report. */
  getCapability(): Capability {
    return this.capability;
  }

  getTier(): QualityTier {
    return this.tier;
  }

  /**
   * Initialize against a real canvas. `init` on the WorldRenderer contract is
   * synchronous-typed; Pixi 8 init is async, so we kick off async setup and
   * expose `ready()` for callers that need to await GPU device creation.
   */
  init(canvas: unknown): void {
    this.canvasEl = canvas as HTMLCanvasElement;
    void this.setup(this.canvasEl);
  }

  private ready: Promise<void> | null = null;

  /** Await GPU device + scene creation (browser callers use this). */
  whenReady(): Promise<void> {
    return this.ready ?? Promise.resolve();
  }

  private setup(canvas: HTMLCanvasElement): Promise<void> {
    const app = new Application();
    this.app = app;

    // Prefer WebGPU when detected; otherwise force WebGL2. We never pass
    // "webgpu" unless capability detection actually observed navigator.gpu.
    const preference: ApplicationOptions["preference"] =
      this.capability.backend === "webgpu" ? "webgpu" : "webgl";

    this.ready = app
      .init({
        canvas,
        preference,
        antialias: true,
        resolution: this.capability.devicePixelRatio,
        autoDensity: true,
        powerPreference: "high-performance",
        backgroundAlpha: 0,
      })
      .then(() => {
        const scene = new ArenaScene();
        this.scene = scene;
        app.stage.addChild(scene.root);
      });

    return this.ready;
  }

  /** Draw one frame. Safe to call before `whenReady` resolves (no-op then). */
  render(frame: RenderFrame): void {
    const app = this.app;
    const scene = this.scene;
    if (!app || !scene) return;

    // Measure frame time using the renderer's own ticker time (browser clock).
    // In tests, render() may be called without a real ticker; guard for that.
    const now = this.pixiTime(app);
    if (this.lastFrameStamp != null && now != null) {
      this.meter.push(now - this.lastFrameStamp);
      this.tier = adaptTier(this.tier, this.meter.average());
    }
    if (now != null) this.lastFrameStamp = now;

    const budget = budgetFor(this.tier);
    scene.update(frame, budget, {
      width: app.renderer.width,
      height: app.renderer.height,
    });
  }

  /** Resize the renderer to a new drawing buffer size. */
  resize(width: number, height: number): void {
    this.app?.renderer.resize(width, height);
  }

  destroy(): void {
    this.scene?.destroy();
    this.scene = null;
    // Deterministic teardown: destroy the Pixi app and its GPU resources.
    this.app?.destroy(true, { children: true, texture: true });
    this.app = null;
    this.meter.reset();
    this.lastFrameStamp = null;
    this.canvasEl = null;
  }

  private pixiTime(app: Application): number | null {
    const t = app.ticker?.lastTime;
    return typeof t === "number" ? t : null;
  }
}
