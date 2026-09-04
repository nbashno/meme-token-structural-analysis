import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Architecture guard — src/api is a thin HTTP surface only.
 *
 * The API layer may import ArenaSession + its own modules and node builtins.
 * It must NOT import Core / scoring config / GMGN adapters, and must NOT compute
 * intelligence or fabricate battlefield/persona values. Proven load-bearing by
 * planted-breach tests below.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SRC = join(HERE, "..", "..", "src");
const API = join(SRC, "api");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts")) out.push(p);
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

const BANNED_IMPORTS = [
  "../core/", "../../core/", "core/power", "core/threat", "core/state",
  "core/features", "config/scoring", "adapters/gmgn",
  "product/intelligence/report", "assembleBattlefield", "evaluateToBattlefield",
];
const BANNED_TOKENS = [
  "computePower", "computeThreat", "computeConfidence", "evaluateToBattlefield",
  "assembleBattlefield", "POWER_CONFIG", "THREAT_CONFIG", "CONFIDENCE_CONFIG",
  "classifyWallet", "walletPersona",
];
const BANNED_FAB = ['power: { score', 'threat: { score', 'persona: "Whale"', 'persona: "Sniper"'];

function offendingImport(src: string): string | null {
  for (const spec of imports(src)) for (const b of BANNED_IMPORTS) if (spec.includes(b)) return `${spec} ~ ${b}`;
  return null;
}
function offendingToken(src: string): string | null {
  for (const t of BANNED_TOKENS) if (src.includes(t)) return t;
  return null;
}
function offendingFab(src: string): string | null {
  for (const t of BANNED_FAB) if (src.includes(t)) return t;
  return null;
}

describe("api architecture guard — src/api is a thin HTTP surface only", () => {
  const files = walk(API);

  it("api layer has files", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const rel = relative(SRC, file).replace(/\\/g, "/");
    const src = readFileSync(file, "utf8");

    it(`${rel}: imports no core / scoring / gmgn`, () => {
      expect(offendingImport(src), `import breach in ${rel}`).toBeNull();
    });
    it(`${rel}: computes no intelligence`, () => {
      expect(offendingToken(src), `intelligence token in ${rel}`).toBeNull();
    });
    it(`${rel}: fabricates no battlefield / persona`, () => {
      expect(offendingFab(src), `fabrication in ${rel}`).toBeNull();
    });
  }
});

describe("api guard is load-bearing — planted breaches must trip it", () => {
  it("trips on a core import", () => {
    expect(offendingImport('import { computePower } from "../core/power/power.js";')).not.toBeNull();
  });
  it("trips on a gmgn import", () => {
    expect(offendingImport('import { run } from "../adapters/gmgn/runner.js";')).not.toBeNull();
  });
  it("trips on computing power", () => {
    expect(offendingToken("const s = computePower(x);")).not.toBeNull();
  });
  it("trips on scoring config", () => {
    expect(offendingToken("const w = POWER_CONFIG;")).not.toBeNull();
  });
  it("trips on fabricating a battlefield score", () => {
    expect(offendingFab("const w = { power: { score: 88 } };")).not.toBeNull();
  });
  it("passes a clean handler line", () => {
    const clean = 'import { httpOk } from "./httpResult.js"; return httpOk(results);';
    expect(offendingImport(clean)).toBeNull();
    expect(offendingToken(clean)).toBeNull();
    expect(offendingFab(clean)).toBeNull();
  });
});
