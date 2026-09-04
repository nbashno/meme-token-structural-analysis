/**
 * WAR world - Renderer abstraction, interaction contracts, replay model (Phase 2).
 *
 * These are CONTRACTS the browser layer implements. Defining them here (in Node-
 * testable form) lets us prove the abstraction and interaction models without a
 * real GPU. Concrete PixiRenderer / PhaserRenderer live in the browser artifact
 * and are chosen by a real benchmark (PENDING_BROWSER_BENCH).
 */

import type { WorldState } from "./worldAdapter.js";
import type { Camera, Lod, WorldInstance } from "./worldEngine.js";

// ── Renderer abstraction ──────────────────────────────────────────────────────

/** A renderer draws instances at a camera. It receives already-projected data. */
export interface WorldRenderer {
  readonly name: "pixi" | "phaser" | "headless";
  init(canvas: unknown): void;
  /** Draw the given visible instances at the camera + per-instance LOD. */
  render(frame: RenderFrame): void;
  destroy(): void;
}

export interface RenderFrame {
  readonly camera: Camera;
  readonly focusedId: string | null;
  readonly instances: readonly RenderInstance[];
}

export interface RenderInstance {
  readonly id: string;
  readonly position: { x: number; y: number };
  readonly lod: Lod;
  readonly state: WorldState | null;
}

/** A headless renderer: records frames, draws nothing. For Node tests. */
export class HeadlessRenderer implements WorldRenderer {
  readonly name = "headless" as const;
  readonly frames: RenderFrame[] = [];
  init(): void {}
  render(frame: RenderFrame): void { this.frames.push(frame); }
  destroy(): void { this.frames.length = 0; }
}

/** Build a RenderFrame from engine state — pure, deterministic. */
export function buildFrame(camera: Camera, focusedId: string | null, instances: readonly WorldInstance[], lodOf: (inst: WorldInstance) => Lod): RenderFrame {
  return {
    camera,
    focusedId,
    instances: instances.map((inst) => ({ id: inst.id, position: inst.position, lod: lodOf(inst), state: inst.state })),
  };
}

// ── Interaction contracts ─────────────────────────────────────────────────────

export type DesktopGesture =
  | { readonly kind: "drag"; readonly dx: number; readonly dy: number }
  | { readonly kind: "wheel"; readonly delta: number }
  | { readonly kind: "click"; readonly id: string }
  | { readonly kind: "dblclick"; readonly id: string };

export type MobileGesture =
  | { readonly kind: "swipe"; readonly dx: number; readonly dy: number }
  | { readonly kind: "pinch"; readonly scale: number }
  | { readonly kind: "tap"; readonly id: string };

export type WorldIntent =
  | { readonly kind: "pan"; readonly dx: number; readonly dy: number }
  | { readonly kind: "zoom"; readonly factor: number }
  | { readonly kind: "select"; readonly id: string }
  | { readonly kind: "enter"; readonly id: string };

/** Map a desktop gesture to a device-independent world intent. Pure. */
export function desktopIntent(g: DesktopGesture): WorldIntent {
  switch (g.kind) {
    case "drag": return { kind: "pan", dx: g.dx, dy: g.dy };
    case "wheel": return { kind: "zoom", factor: g.delta < 0 ? 1.1 : 0.9 };
    case "click": return { kind: "select", id: g.id };
    case "dblclick": return { kind: "enter", id: g.id };
  }
}

/** Map a mobile gesture to the SAME world intents (same data, different input). */
export function mobileIntent(g: MobileGesture): WorldIntent {
  switch (g.kind) {
    case "swipe": return { kind: "pan", dx: g.dx, dy: g.dy };
    case "pinch": return { kind: "zoom", factor: g.scale };
    case "tap": return { kind: "select", id: g.id };
  }
}

// ── Battle Replay model (ARCHITECTURE_READY) ─────────────────────────────────

/**
 * Replay plays back a sequence of historical WorldStates. The data MODEL and
 * controller are defined here and fully testable. Actual historical frames
 * require a persistence read method that does NOT exist in Phase 1
 * (MonitoringObservationRepository has append + lastFingerprint, no list).
 * We do NOT invent it and do NOT modify Phase 1. Status:
 *   BATTLE_REPLAY = BLOCKED_BY_HISTORY_READ_CONTRACT
 */
export interface ReplayFrame {
  readonly at: number;
  readonly state: WorldState;
}

export type ReplaySpeed = 1 | 2 | 5 | 10;

export interface ReplayState {
  readonly frames: readonly ReplayFrame[];
  readonly index: number;
  readonly playing: boolean;
  readonly speed: ReplaySpeed;
}

export function initReplay(frames: readonly ReplayFrame[]): ReplayState {
  return { frames, index: 0, playing: false, speed: 1 };
}

export function play(s: ReplayState): ReplayState { return { ...s, playing: true }; }
export function pause(s: ReplayState): ReplayState { return { ...s, playing: false }; }
export function setSpeed(s: ReplayState, speed: ReplaySpeed): ReplayState { return { ...s, speed }; }

export function step(s: ReplayState): ReplayState {
  if (!s.playing || s.frames.length === 0) return s;
  const next = Math.min(s.frames.length - 1, s.index + 1);
  return { ...s, index: next, playing: next < s.frames.length - 1 };
}

export function jumpToEvent(s: ReplayState, at: number): ReplayState {
  if (s.frames.length === 0) return s;
  let best = 0;
  for (let i = 0; i < s.frames.length; i++) if (s.frames[i]!.at <= at) best = i;
  return { ...s, index: best };
}

export function currentFrame(s: ReplayState): ReplayFrame | null {
  return s.frames[s.index] ?? null;
}
