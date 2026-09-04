import { describe, it, expect } from "vitest";
import {
  adaptTier,
  budgetFor,
  FrameMeter,
  tierForFrameTime,
} from "../../src/experience/adaptiveQuality.js";
import { seamGeometry } from "../../src/experience/visual/battlefieldSeam.js";
import {
  attentionRadius,
  forceWidth01,
  laneTint,
  moodTone,
  PALETTE,
} from "../../src/experience/visual/vocabulary.js";
import { frameFor } from "../../src/experience/experienceAdapter.js";
import { WorldEngine, INITIAL_CAMERA } from "../../src/world/worldEngine.js";

describe("adaptive quality — presentation only, hysteresis, never touches data", () => {
  it("maps frame time to tiers", () => {
    expect(tierForFrameTime(8)).toBe("ULTRA");
    expect(tierForFrameTime(16)).toBe("HIGH");
    expect(tierForFrameTime(24)).toBe("MEDIUM");
    expect(tierForFrameTime(40)).toBe("LOW");
  });

  it("adapts one step at a time (no flicker)", () => {
    // From ULTRA under heavy load, we step down one level per call.
    expect(adaptTier("ULTRA", 40)).toBe("HIGH");
    expect(adaptTier("HIGH", 40)).toBe("MEDIUM");
    expect(adaptTier("MEDIUM", 40)).toBe("LOW");
    expect(adaptTier("LOW", 40)).toBe("LOW");
  });

  it("steps up one level when headroom returns", () => {
    expect(adaptTier("LOW", 8)).toBe("MEDIUM");
    expect(adaptTier("MEDIUM", 8)).toBe("HIGH");
    expect(adaptTier("HIGH", 8)).toBe("ULTRA");
  });

  it("budgets shrink with tier", () => {
    expect(budgetFor("ULTRA").particlesPerWorld).toBeGreaterThan(budgetFor("LOW").particlesPerWorld);
    expect(budgetFor("LOW").secondaryEffects).toBe(false);
    expect(budgetFor("ULTRA").secondaryEffects).toBe(true);
  });

  it("FrameMeter averages a rolling window", () => {
    const m = new FrameMeter(3);
    m.push(10); m.push(20); m.push(30);
    expect(m.average()).toBeCloseTo(20);
    m.push(60); // 20,30,60
    expect(m.average()).toBeCloseTo(110 / 3);
  });
});

describe("battlefield seam — geometry only, no new score", () => {
  it("splits proportionally to the two raw forces", () => {
    const s = seamGeometry(75, 25);
    expect(s.powerRaw).toBe(75);
    expect(s.threatRaw).toBe(25);
    expect(s.seam01).toBeCloseTo(0.75);
  });

  it("sits at the exact middle when both are zero (honest, no advantage)", () => {
    expect(seamGeometry(0, 0).seam01).toBe(0.5);
  });

  it("preserves raw values untouched", () => {
    const s = seamGeometry(12.5, 87.5);
    expect(s.powerRaw).toBe(12.5);
    expect(s.threatRaw).toBe(87.5);
  });
});

describe("visual vocabulary — pure mapping", () => {
  it("forceWidth01 normalizes and clamps", () => {
    expect(forceWidth01(50)).toBeCloseTo(0.5);
    expect(forceWidth01(150)).toBe(1);
    expect(forceWidth01(-5)).toBe(0);
    expect(forceWidth01(NaN)).toBe(0);
  });

  it("attentionRadius scales within bounds", () => {
    expect(attentionRadius(0, 10, 34)).toBe(10);
    expect(attentionRadius(100, 10, 34)).toBe(34);
  });

  it("moodTone covers every real mood and never throws", () => {
    for (const mood of ["UNKNOWN","OBSERVING","EMERGING","ACCUMULATION","ATTACK","DOMINANCE","DISTRIBUTION","BLEEDING","COLLAPSE","DORMANT"] as const) {
      expect(typeof moodTone(mood)).toBe("number");
    }
  });

  it("laneTint maps the four real provenance lanes", () => {
    expect(laneTint("SMART_MONEY")).toBe(PALETTE.power);
    expect(laneTint("KOL")).toBe(PALETTE.attention);
    expect(laneTint("FOLLOW_WALLET")).toBe(PALETTE.sub);
    expect(laneTint("OTHER")).toBe(PALETTE.neutral);
  });
});

describe("experience adapter — pure streaming bridge, reuses WorldEngine", () => {
  it("packages only engine-visible instances into a RenderFrame", () => {
    const engine = new WorldEngine();
    engine.ensure("solana:a", { x: 0, y: 0 });
    engine.ensure("solana:b", { x: 100, y: 0 });
    engine.mount("solana:a");
    engine.mount("solana:b");

    // At zoom 1, lodFor → 1, so both are visible.
    const frame = frameFor(engine, INITIAL_CAMERA, "solana:a");
    expect(frame.instances.length).toBe(2);
    expect(frame.focusedId).toBe("solana:a");
    expect(frame.camera).toEqual(INITIAL_CAMERA);
  });

  it("excludes sleeping instances (streaming culls them)", () => {
    const engine = new WorldEngine();
    engine.ensure("solana:a", { x: 0, y: 0 });
    engine.ensure("solana:b", { x: 0, y: 0 });
    engine.mount("solana:a");
    engine.mount("solana:b");
    engine.sleep("solana:b");

    const frame = frameFor(engine, INITIAL_CAMERA, null);
    expect(frame.instances.map((i) => i.id)).toEqual(["solana:a"]);
  });
});
