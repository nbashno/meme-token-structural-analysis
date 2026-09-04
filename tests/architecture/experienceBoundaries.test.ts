import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Architecture guard — src/experience is a GPU VIEW only (Phase A / A5).
 *
 * The experience (GPU) layer may read WorldState (via RenderFrame) and nothing
 * else. This guard fails if the renderer:
 *   - imports Core / Product-intelligence / adapters / scoring config
 *   - computes any intelligence (power/threat/confidence/attention/…)
 *   - classifies wallets or invents personas
 *   - fabricates a battlefield / new factors
 *   - accesses GMGN directly
 *
 * These guards are LOAD-BEARING, proven by planted-breach tests below: a
 * synthetic violating source must trip each rule.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SRC = join(HERE, "..", "..", "src");
const EXPERIENCE = join(SRC, "experience");

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

// ── The rules, as pure predicates so the same logic guards real files AND
//    planted breaches. Each returns an offending token, or null if clean. ──────

const BANNED_IMPORTS = [
  "core/power", "core/threat", "core/state", "core/temporal", "core/flow",
  "core/coherence", "core/novelty", "core/attention", "core/features",
  "core/confidence", "config/scoring", "product/intelligence",
  "assembleBattlefield", "evaluateToBattlefield", "adapters/gmgn",
  // Any climb into core/ at all:
  "../core/", "../../core/", "../product/intelligence", "../../product/intelligence",
];

const BANNED_TOKENS = [
  "computePower", "computeThreat", "computeConfidence", "computeAttention",
  "evaluateToBattlefield", "assembleBattlefield",
  "POWER_CONFIG", "THREAT_CONFIG", "CONFIDENCE_CONFIG",
  "classifyWallet", "walletPersona", "computeWalletScore", "battleScore",
];

const BANNED_FABRICATIONS = [
  'power: { score', 'threat: { score',
  'persona: "Whale"', 'persona: "Sniper"', 'persona: "Hunter"',
  'persona: "Insider"', 'persona: "Dev"',
];

function offendingImport(src: string): string | null {
  for (const spec of imports(src)) {
    for (const b of BANNED_IMPORTS) if (spec.includes(b)) return `${spec} ~ ${b}`;
  }
  return null;
}

function offendingToken(src: string): string | null {
  for (const t of BANNED_TOKENS) if (src.includes(t)) return t;
  return null;
}

function offendingFabrication(src: string): string | null {
  for (const t of BANNED_FABRICATIONS) if (src.includes(t)) return t;
  return null;
}

describe("experience architecture guard — src/experience is a GPU view only", () => {
  const files = walk(EXPERIENCE);

  it("experience layer has files", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const rel = relative(SRC, file).replace(/\\/g, "/");
    const src = readFileSync(file, "utf8");

    it(`${rel}: imports no core / product-intelligence / gmgn / scoring`, () => {
      expect(offendingImport(src), `import breach in ${rel}`).toBeNull();
    });

    it(`${rel}: computes no intelligence`, () => {
      expect(offendingToken(src), `intelligence token in ${rel}`).toBeNull();
    });

    it(`${rel}: fabricates no battlefield / persona`, () => {
      expect(offendingFabrication(src), `fabrication in ${rel}`).toBeNull();
    });
  }
});

describe("experience guard is load-bearing — planted breaches must trip it", () => {
  it("trips on a core import", () => {
    const breach = `import { computePower } from "../core/power/power.js";`;
    expect(offendingImport(breach)).not.toBeNull();
  });

  it("trips on climbing into core/", () => {
    const breach = `import { x } from "../../core/state/stateMachine.js";`;
    expect(offendingImport(breach)).not.toBeNull();
  });

  it("trips on a gmgn import", () => {
    const breach = `import { run } from "../adapters/gmgn/runner.js";`;
    expect(offendingImport(breach)).not.toBeNull();
  });

  it("trips on computing power", () => {
    const breach = `const s = computePower(obs); return s;`;
    expect(offendingToken(breach)).not.toBeNull();
  });

  it("trips on scoring config use", () => {
    const breach = `const w = POWER_CONFIG.weights;`;
    expect(offendingToken(breach)).not.toBeNull();
  });

  it("trips on wallet classification", () => {
    const breach = `const p = classifyWallet(addr);`;
    expect(offendingToken(breach)).not.toBeNull();
  });

  it("trips on fabricating a battlefield score", () => {
    const breach = `const w = { power: { score: 88 } };`;
    expect(offendingFabrication(breach)).not.toBeNull();
  });

  it("trips on inventing a persona", () => {
    const breach = `const e = { persona: "Whale" };`;
    expect(offendingFabrication(breach)).not.toBeNull();
  });

  it("passes a clean presentational line", () => {
    const clean = `import { moodTone } from "./visual/vocabulary.js"; g.circle(0,0,4);`;
    expect(offendingImport(clean)).toBeNull();
    expect(offendingToken(clean)).toBeNull();
    expect(offendingFabrication(clean)).toBeNull();
  });
});
