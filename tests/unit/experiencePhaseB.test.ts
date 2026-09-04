import { describe, it, expect } from "vitest";
import { toInspectorView } from "../../src/experience/inspectorView.js";
import {
  initInteraction,
  reduceIntent,
  clearFly,
} from "../../src/experience/arenaInteraction.js";
import { radarBlips } from "../../src/experience/radarBridge.js";
import { startFly, advanceFly, cancelFly } from "../../src/experience/cameraAnimator.js";
import { INITIAL_CAMERA, WorldEngine } from "../../src/world/worldEngine.js";
import type { WorldState } from "../../src/world/worldAdapter.js";

// Minimal WorldState fixture — shaped exactly like the real projection output.
function fixture(over: Partial<WorldState> = {}): WorldState {
  const base: WorldState = {
    chain: "solana",
    address: "abc",
    generatedAt: 1000,
    mood: "ATTACK",
    trajectory: "ACCELERATING_UP",
    coherence: "ALIGNED",
    leadLag: "FLOW_LEADS",
    regime: "RISK_ON",
    power: { raw: 70, visual01: 0.7, band: "Elevated" },
    threat: { raw: 30, visual01: 0.3, band: "Moderate" },
    confidence: { raw: 60, visual01: 0.6, band: "Elevated" },
    attention: { raw: 80, visual01: 0.8, band: "High" },
    events: [
      { type: "SMART_ENTRY", importance: 0.5, reason: "r1" },
      { type: "STATE_TRANSITION", importance: 0.9, reason: "r2" },
    ],
    signals: [{ identity: "ACCUMULATION", phase: "CONFIRMED" }],
    whyNow: ["because flow leads"],
    flowEntities: [
      { maker: "w1", side: "buy", amountUsd: 1000, lane: "SMART_MONEY", persona: "UNKNOWN" },
    ],
    dataQuality: "GOOD",
    qualityReasons: ["6 of 10 confirmed"],
    insufficient: ["liquidityFragility", "measurementStability"],
    visual: { territorySize01: 0.8, contestBalance01: 0.7 },
  };
  return { ...base, ...over };
}

describe("inspector view — pure projection, surfaces INSUFFICIENT honestly", () => {
  it("passes every force through unchanged", () => {
    const v = toInspectorView(fixture());
    expect(v.power.raw).toBe(70);
    expect(v.threat.raw).toBe(30);
    expect(v.confidence.raw).toBe(60);
    expect(v.attention.raw).toBe(80);
  });

  it("orders events by existing importance (no new score)", () => {
    const v = toInspectorView(fixture());
    expect(v.events.map((e) => e.type)).toEqual(["STATE_TRANSITION", "SMART_ENTRY"]);
  });

  it("keeps INSUFFICIENT list intact — never converts to 0", () => {
    const v = toInspectorView(fixture());
    expect(v.insufficient).toEqual(["liquidityFragility", "measurementStability"]);
  });

  it("keeps flow persona UNKNOWN (no classifier)", () => {
    const v = toInspectorView(fixture());
    expect(v.flows[0]!.persona).toBe("UNKNOWN");
  });
});

describe("arena interaction — one pure path for desktop + mobile", () => {
  const posOf = (id: string) => (id === "solana:a" ? { x: 50, y: 20 } : null);

  it("select changes focus only", () => {
    const s0 = initInteraction(INITIAL_CAMERA);
    const s1 = reduceIntent(s0, { kind: "select", id: "solana:a" }, posOf);
    expect(s1.focusedId).toBe("solana:a");
    expect(s1.camera).toEqual(INITIAL_CAMERA);
  });

  it("enter sets focus + flyTarget from world position", () => {
    const s0 = initInteraction(INITIAL_CAMERA);
    const s1 = reduceIntent(s0, { kind: "enter", id: "solana:a" }, posOf);
    expect(s1.enteredId).toBe("solana:a");
    expect(s1.flyTarget).toEqual({ x: 50, y: 20, zoom: 2.5 });
  });

  it("enter on unknown id focuses without a fly", () => {
    const s0 = initInteraction(INITIAL_CAMERA);
    const s1 = reduceIntent(s0, { kind: "enter", id: "ghost" }, posOf);
    expect(s1.focusedId).toBe("ghost");
    expect(s1.flyTarget).toBeNull();
  });

  it("pan is zoom-compensated", () => {
    const s0 = initInteraction({ x: 0, y: 0, zoom: 2 });
    const s1 = reduceIntent(s0, { kind: "pan", dx: 20, dy: 0 }, posOf);
    expect(s1.camera.x).toBe(-10); // -20 / 2
  });

  it("zoom multiplies and clamps", () => {
    const s0 = initInteraction({ x: 0, y: 0, zoom: 1 });
    const s1 = reduceIntent(s0, { kind: "zoom", factor: 1.1 }, posOf);
    expect(s1.camera.zoom).toBeCloseTo(1.1);
  });

  it("clearFly drops a consumed target", () => {
    const s0 = { ...initInteraction(INITIAL_CAMERA), flyTarget: { x: 1, y: 2, zoom: 3 } };
    expect(clearFly(s0).flyTarget).toBeNull();
  });
});

describe("radar bridge — reuses existing projection, single-field order", () => {
  it("orders live worlds by a single existing field, no composite", () => {
    const engine = new WorldEngine();
    engine.ensure("solana:a", { x: 0, y: 0 });
    engine.ensure("solana:b", { x: 0, y: 0 });
    engine.mount("solana:a"); engine.mount("solana:b");
    engine.update("solana:a", fixture({ address: "a", power: { raw: 40, visual01: 0.4, band: "Moderate" } }));
    engine.update("solana:b", fixture({ address: "b", power: { raw: 90, visual01: 0.9, band: "High" } }));

    const blips = radarBlips(engine, ["solana:a", "solana:b"], "power");
    expect(blips.map((b) => b.power)).toEqual([90, 40]);
  });

  it("skips instances without state", () => {
    const engine = new WorldEngine();
    engine.ensure("solana:a", { x: 0, y: 0 });
    engine.mount("solana:a"); // no update → no state
    expect(radarBlips(engine, ["solana:a"], "power")).toEqual([]);
  });
});

describe("camera animator — deterministic, cancellable, ends exactly on target", () => {
  it("reaches the target exactly at the end", () => {
    const anim = startFly({ x: 0, y: 0, zoom: 1 }, { x: 100, y: 0, zoom: 2 }, 500);
    const { camera, anim: a1 } = advanceFly(anim, 500);
    expect(a1.done).toBe(true);
    expect(camera).toEqual({ x: 100, y: 0, zoom: 2 });
  });

  it("interpolates partway", () => {
    const anim = startFly({ x: 0, y: 0, zoom: 1 }, { x: 100, y: 0, zoom: 1 }, 500);
    const { camera } = advanceFly(anim, 250);
    expect(camera.x).toBeGreaterThan(0);
    expect(camera.x).toBeLessThan(100);
  });

  it("cancel freezes the animation", () => {
    const anim = startFly({ x: 0, y: 0, zoom: 1 }, { x: 100, y: 0, zoom: 2 }, 500);
    const cancelled = cancelFly(anim);
    expect(cancelled.done).toBe(true);
  });
});
