import { describe, it, expect } from "vitest";

import { toWorldState } from "../../src/world/worldAdapter.js";
import {
  WorldEngine, lodFor, pan, zoomTo, flyStep, INITIAL_CAMERA,
} from "../../src/world/worldEngine.js";
import {
  HeadlessRenderer, buildFrame, desktopIntent, mobileIntent,
  initReplay, play, step, jumpToEvent, setSpeed, currentFrame, type ReplayFrame,
} from "../../src/world/worldRenderer.js";
import { toRadarBlip, radarOrder, UnavailableSearchPort } from "../../src/world/worldRadar.js";
import { buildIntelligenceReport } from "../../src/product/intelligence/report.js";
import { makeEntry, makeBattlefield } from "./productFixtures.js";
import type { FlowObservation } from "../../src/core/timeline/types.js";
import type { UnixMillis } from "../../src/shared/scalars.js";

function report(over: Record<string, unknown> = {}) {
  const entry = makeEntry({ address: "TokenAAA", power: 82, threat: 24, attention: 44, state: "ATTACK", ...over });
  const bf = makeBattlefield([entry]);
  return buildIntelligenceReport(bf, bf.tokens[0]!);
}

function flow(provenance: string, side: "buy" | "sell", usd: number): FlowObservation {
  return { meta: { at: 1500 as UnixMillis, temporalOrigin: "GMGN_EVENT", coverage: "ROLLING", provenance: provenance as never }, maker: "wX", side, amountUsd: usd, priceUsd: 1, positionEvent: "FULL_OPEN", fullness: "FULL", direction: "OPEN" };
}

describe("2 World Adapter — pure projection", () => {
  it("passes raw scores through unchanged", () => {
    const w = toWorldState({ report: report() });
    expect(w.power.raw).toBe(82);
    expect(w.threat.raw).toBe(24);
    expect(w.power.visual01).toBeCloseTo(0.82, 9); // visual only, separate from raw
  });

  it("mood = the real Core state (no new state invented)", () => {
    expect(toWorldState({ report: report() }).mood).toBe("ATTACK");
  });

  it("deterministic: same report -> byte-identical WorldState", () => {
    expect(JSON.stringify(toWorldState({ report: report() }))).toBe(JSON.stringify(toWorldState({ report: report() })));
  });

  it("flow -> entities by provenance lane, persona always UNKNOWN", () => {
    const w = toWorldState({ report: report(), flow: [flow("track.smartmoney", "buy", 8000), flow("track.kol", "sell", 3000)] });
    expect(w.flowEntities[0]!.lane).toBe("SMART_MONEY");
    expect(w.flowEntities[0]!.persona).toBe("UNKNOWN");
    expect(w.flowEntities[1]!.lane).toBe("KOL");
    expect(w.flowEntities[0]!.amountUsd).toBe(8000); // passed through, not scored
  });

  it("surfaces INSUFFICIENT markers instead of hiding them", () => {
    // makeEntry quality reasons include the insufficient list in scan
    const w = toWorldState({ report: report() });
    expect(Array.isArray(w.insufficient)).toBe(true);
    expect(w.qualityReasons.length).toBeGreaterThan(0);
  });

  it("orders events by importance (presentation ordering only)", () => {
    const w = toWorldState({ report: report({ events: [
      { type: "REVERSAL", at: 1 as never, severity: 5 as never, importance: 20 as never, reasons: ["a"], beforeState: "OBSERVING", afterState: "ATTACK" },
      { type: "POWER_BREAKOUT", at: 1 as never, severity: 5 as never, importance: 90 as never, reasons: ["b"], beforeState: "OBSERVING", afterState: "ATTACK" },
    ] }) });
    expect(w.events[0]!.type).toBe("POWER_BREAKOUT");
  });
});

describe("2 Camera + LOD", () => {
  it("pan/zoom are pure transforms", () => {
    expect(pan(INITIAL_CAMERA, 10, -5)).toEqual({ x: 10, y: -5, zoom: 1 });
    expect(zoomTo(INITIAL_CAMERA, 100).zoom).toBe(8); // clamped to max
    expect(zoomTo(INITIAL_CAMERA, 0).zoom).toBe(0.1); // clamped to min
  });
  it("flyStep interpolates toward target", () => {
    const c = flyStep(INITIAL_CAMERA, { x: 100, y: 0, zoom: 4 }, 0.5);
    expect(c.x).toBe(50); expect(c.zoom).toBe(2.5);
  });
  it("LOD rises with zoom and focus", () => {
    expect(lodFor(0.3, false)).toBe(0);
    expect(lodFor(1.0, false)).toBe(1);
    expect(lodFor(0.3, true)).toBe(2); // focused overrides
    expect(lodFor(3.0, false)).toBe(2);
  });
});

describe("2 World Engine lifecycle + streaming", () => {
  it("one engine, many instances, keyed by id", () => {
    const e = new WorldEngine();
    e.ensure("sol:A", { x: 0, y: 0 });
    e.ensure("sol:B", { x: 10, y: 0 });
    e.ensure("sol:A", { x: 0, y: 0 }); // idempotent
    expect(e.count()).toBe(2);
  });

  it("lifecycle create->mount->sleep->wake->destroy", () => {
    const e = new WorldEngine();
    e.ensure("sol:A", { x: 0, y: 0 });
    e.mount("sol:A"); expect(e.get("sol:A")!.phase).toBe("MOUNTED");
    e.sleep("sol:A"); expect(e.get("sol:A")!.phase).toBe("SLEEPING");
    e.wake("sol:A"); expect(e.get("sol:A")!.phase).toBe("MOUNTED");
    e.destroy("sol:A"); expect(e.get("sol:A")).toBeNull();
  });

  it("streaming: only visible (LOD>=1) non-sleeping instances render", () => {
    const e = new WorldEngine();
    e.ensure("sol:A", { x: 0, y: 0 }); e.mount("sol:A");
    e.ensure("sol:B", { x: 0, y: 0 }); e.mount("sol:B"); e.sleep("sol:B");
    const visibleFar = e.visible({ x: 0, y: 0, zoom: 0.3 }, null); // LOD 0 -> not visible
    expect(visibleFar.length).toBe(0);
    const visibleNear = e.visible({ x: 0, y: 0, zoom: 1.5 }, null);
    expect(visibleNear.map((i) => i.id)).toEqual(["sol:A"]); // B is sleeping
  });

  it("10,000-world DATA/OBJECT stress (architecture, not FPS)", () => {
    const e = new WorldEngine();
    for (let i = 0; i < 10_000; i++) e.ensure(`sol:T${i}`, { x: i % 100, y: Math.floor(i / 100) });
    expect(e.count()).toBe(10_000);
    // visibility filter runs over 10k without materializing full render for all
    const vis = e.visible({ x: 0, y: 0, zoom: 0.3 }, "sol:T5000"); // only focused reaches LOD2
    expect(vis.length).toBe(1);
    expect(vis[0]!.id).toBe("sol:T5000");
  });
});

describe("2 Renderer abstraction + interaction contracts", () => {
  it("headless renderer records frames without drawing", () => {
    const r = new HeadlessRenderer();
    const frame = buildFrame(INITIAL_CAMERA, null, [], () => 0);
    r.render(frame);
    expect(r.frames.length).toBe(1);
  });

  it("desktop and mobile gestures map to the SAME world intents", () => {
    expect(desktopIntent({ kind: "drag", dx: 5, dy: 5 })).toEqual({ kind: "pan", dx: 5, dy: 5 });
    expect(mobileIntent({ kind: "swipe", dx: 5, dy: 5 })).toEqual({ kind: "pan", dx: 5, dy: 5 });
    expect(desktopIntent({ kind: "dblclick", id: "sol:A" })).toEqual({ kind: "enter", id: "sol:A" });
    expect(mobileIntent({ kind: "tap", id: "sol:A" })).toEqual({ kind: "select", id: "sol:A" });
  });
});

describe("2 Radar + Search", () => {
  it("radar orders by a single existing field (no composite)", () => {
    const blips = [
      toRadarBlip(toWorldState({ report: report({ address: "A", power: 40 }) })),
      toRadarBlip(toWorldState({ report: report({ address: "B", power: 90 }) })),
    ];
    expect(radarOrder(blips, "power")[0]!.power).toBe(90);
  });
  it("search backend is explicitly unavailable (no fake results)", async () => {
    const port = new UnavailableSearchPort();
    expect(await port.search({ text: "ELMO" })).toEqual([]);
  });
});

describe("2 Battle Replay model (ARCHITECTURE_READY)", () => {
  const frames: ReplayFrame[] = [
    { at: 1000, state: toWorldState({ report: report({ address: "A", power: 40 }) }) },
    { at: 2000, state: toWorldState({ report: report({ address: "A", power: 60 }) }) },
    { at: 3000, state: toWorldState({ report: report({ address: "A", power: 80 }) }) },
  ];
  it("play advances frames; speed settable", () => {
    let s = initReplay(frames);
    s = play(s); s = step(s);
    expect(s.index).toBe(1);
    s = setSpeed(s, 5);
    expect(s.speed).toBe(5);
  });
  it("jumpToEvent seeks to the frame at/just before a timestamp", () => {
    let s = initReplay(frames);
    s = jumpToEvent(s, 2500);
    expect(currentFrame(s)!.at).toBe(2000);
  });
});
