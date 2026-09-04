import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { toScanViewModel } from "../../src/ui/scanViewModel.js";
import { buildIntelligenceReport } from "../../src/product/intelligence/report.js";
import { makeEntry, makeBattlefield } from "./productFixtures.js";

// ── view-model: 1:1 mapping, formatting only ─────────────────────────────────

function report() {
  const entry = makeEntry({
    address: "TokenAAA", power: 82, threat: 20, attention: 40, state: "ATTACK",
    supporting: [{ factor: "trajectory_up", magnitude: 24, weight: 30 }],
  });
  const bf = makeBattlefield([entry]);
  return buildIntelligenceReport(bf, bf.tokens[0]!);
}

describe("9 scanViewModel — pure formatting, no intelligence", () => {
  it("passes computed scores through unchanged (value is the raw number)", () => {
    const vm = toScanViewModel(report());
    expect(vm.power.value).toBe(82);
    expect(vm.threat.value).toBe(20);
  });

  it("band label is presentational only and does not alter the value", () => {
    const vm = toScanViewModel(report());
    expect(vm.power.label).toBe("High"); // 82 >= 75
    expect(vm.threat.label).toBe("Low"); // 20 < 25
    // value still exact
    expect(vm.power.value).toBe(82);
  });

  it("humanizes enums without changing meaning", () => {
    const vm = toScanViewModel(report());
    expect(vm.state).toBe("Attack");
  });

  it("maps evidence/contributions 1:1 from the report", () => {
    const vm = toScanViewModel(report());
    expect(vm.powerSupporting.length).toBe(1);
    expect(vm.powerSupporting[0]!.magnitude).toBe(24);
    expect(vm.powerSupporting[0]!.weight).toBe(30);
  });

  it("pins model versions from the report (auditability)", () => {
    const vm = toScanViewModel(report());
    expect(vm.confidenceModelVersion).toBe("confidence-v2");
    expect(vm.activationModelVersion).toBe("activation-v1");
  });

  it("orders events by importance (presentation ordering, not recomputation)", () => {
    const entry = makeEntry({
      address: "TokenAAA",
      events: [
        { type: "REVERSAL", at: 1000 as never, severity: 50 as never, importance: 30 as never, reasons: ["r1"], beforeState: "OBSERVING", afterState: "ATTACK" },
        { type: "POWER_BREAKOUT", at: 1000 as never, severity: 50 as never, importance: 90 as never, reasons: ["r2"], beforeState: "OBSERVING", afterState: "ATTACK" },
      ],
    });
    const bf = makeBattlefield([entry]);
    const vm = toScanViewModel(buildIntelligenceReport(bf, bf.tokens[0]!));
    expect(vm.events[0]!.type).toBe("Power breakout"); // importance 90 first
  });
});

// ── architecture guard: UI must not import any engine ────────────────────────

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SRC = join(HERE, "..", "..", "src");
const UI = join(SRC, "ui");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

function imports(src: string): string[] {
  const specs: string[] = [];
  const re = /(?:import|export)[^'"]*from\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) if (m[1]) specs.push(m[1]);
  return specs;
}

describe("9 architecture — src/ui is presentation only", () => {
  const files = walk(UI);

  it("ui has files", () => { expect(files.length).toBeGreaterThan(0); });

  for (const file of files) {
    const rel = relative(SRC, file);
    const src = readFileSync(file, "utf8");

    it(`${rel}: imports no engine/core intelligence`, () => {
      const banned = ["core/power", "core/threat", "core/state/stateMachine", "core/temporal", "core/flow", "core/coherence", "core/novelty", "core/attention", "core/events", "core/features", "config/scoring", "assembleBattlefield", "adapters/gmgn"];
      for (const spec of imports(src)) {
        for (const b of banned) {
          expect(spec.includes(b), `ui file ${rel} imports engine "${spec}"`).toBe(false);
        }
      }
    });

    it(`${rel}: computes no intelligence (no scoring tokens)`, () => {
      for (const token of ["computePower", "computeThreat", "computeConfidence", "evaluateToBattlefield", "POWER_CONFIG", "THREAT_CONFIG"]) {
        expect(src.includes(token), `ui file ${rel} computes intelligence via "${token}"`).toBe(false);
      }
    });
  }
});
