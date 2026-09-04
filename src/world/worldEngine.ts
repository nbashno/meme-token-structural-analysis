/**
 * WAR world - World Engine + instance lifecycle + camera + LOD (Phase 2).
 *
 * ONE WorldEngine holds many WorldInstances (one per token). Instances differ
 * only by their WorldState data. This module is pure data-model + lifecycle; it
 * does NOT render and contains NO intelligence. It is fully testable in Node.
 *
 * The renderer (browser-only) consumes these structures via the WorldRenderer
 * abstraction; it is never imported here.
 */

import type { WorldState } from "./worldAdapter.js";

// ── LOD ───────────────────────────────────────────────────────────────────────

/** Level of detail affects RENDERING ONLY, never intelligence. */
export type Lod = 0 | 1 | 2;

/** Choose LOD from camera zoom + whether the instance is focused. Presentation. */
export function lodFor(zoom: number, focused: boolean): Lod {
  if (focused || zoom >= 2.0) return 2; // full battlefield
  if (zoom >= 0.8) return 1; // world + state
  return 0; // minimal (dot / territory / label)
}

// ── Camera ────────────────────────────────────────────────────────────────────

export interface Camera {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export const INITIAL_CAMERA: Camera = { x: 0, y: 0, zoom: 1 };

export function pan(cam: Camera, dx: number, dy: number): Camera {
  return { ...cam, x: cam.x + dx, y: cam.y + dy };
}

export function zoomTo(cam: Camera, zoom: number, min = 0.1, max = 8): Camera {
  return { ...cam, zoom: Math.max(min, Math.min(max, zoom)) };
}

/** flyTo target: a pure interpolation step (renderer animates between steps). */
export function flyStep(cam: Camera, target: { x: number; y: number; zoom: number }, t: number): Camera {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  return {
    x: cam.x + (target.x - cam.x) * k,
    y: cam.y + (target.y - cam.y) * k,
    zoom: cam.zoom + (target.zoom - cam.zoom) * k,
  };
}

// ── World Instance lifecycle ────────────────────────────────────────────────

export type InstancePhase = "CREATED" | "MOUNTED" | "SLEEPING" | "DESTROYED";

export interface WorldPosition {
  readonly x: number;
  readonly y: number;
}

export interface WorldInstance {
  readonly id: string; // chain:address
  readonly position: WorldPosition;
  readonly phase: InstancePhase;
  readonly state: WorldState | null; // latest projected state (null until first update)
}

export function createInstance(id: string, position: WorldPosition): WorldInstance {
  return { id, position, phase: "CREATED", state: null };
}

// ── World Engine ──────────────────────────────────────────────────────────────

export class WorldEngine {
  private readonly instances = new Map<string, WorldInstance>();

  /** Create (or return) the single instance for a token id. */
  ensure(id: string, position: WorldPosition): WorldInstance {
    const existing = this.instances.get(id);
    if (existing) return existing;
    const inst = createInstance(id, position);
    this.instances.set(id, inst);
    return inst;
  }

  mount(id: string): void {
    this.transition(id, "MOUNTED");
  }

  sleep(id: string): void {
    this.transition(id, "SLEEPING");
  }

  wake(id: string): void {
    this.transition(id, "MOUNTED");
  }

  destroy(id: string): void {
    this.transition(id, "DESTROYED");
    this.instances.delete(id);
  }

  /** Push a freshly-projected WorldState onto an instance (no computation). */
  update(id: string, state: WorldState): void {
    const inst = this.instances.get(id);
    if (!inst || inst.phase === "DESTROYED") return;
    this.instances.set(id, { ...inst, state });
  }

  get(id: string): WorldInstance | null {
    return this.instances.get(id) ?? null;
  }

  count(): number {
    return this.instances.size;
  }

  /** Instances whose LOD >= 1 at the given camera (streaming: only these render fully). */
  visible(cam: Camera, focusedId: string | null): readonly WorldInstance[] {
    const out: WorldInstance[] = [];
    for (const inst of this.instances.values()) {
      if (inst.phase === "DESTROYED" || inst.phase === "SLEEPING") continue;
      const lod = lodFor(cam.zoom, inst.id === focusedId);
      if (lod >= 1) out.push(inst);
    }
    return out;
  }

  private transition(id: string, phase: InstancePhase): void {
    const inst = this.instances.get(id);
    if (!inst) return;
    this.instances.set(id, { ...inst, phase });
  }
}
