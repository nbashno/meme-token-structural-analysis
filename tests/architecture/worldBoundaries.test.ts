import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SRC = join(HERE, "..", "..", "src");
const WORLD = join(SRC, "world");

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

describe("2 World architecture guard — src/world is projection only", () => {
  const files = walk(WORLD);
  it("world has files", () => { expect(files.length).toBeGreaterThan(0); });

  for (const file of files) {
    const rel = relative(SRC, file).replace(/\\/g, "/");
    const src = readFileSync(file, "utf8");

    it(`${rel}: imports no core engine / scoring config`, () => {
      const banned = [
        "core/power", "core/threat", "core/state/stateMachine", "core/temporal",
        "core/flow/flowEngine", "core/coherence/coherence", "core/novelty", "core/attention",
        "core/features", "config/scoring", "assembleBattlefield", "adapters/gmgn",
      ];
      for (const spec of imports(src)) {
        for (const b of banned) {
          expect(spec.includes(b), `world file ${rel} imports engine "${spec}"`).toBe(false);
        }
      }
    });

    it(`${rel}: computes no intelligence (no scoring/classification tokens)`, () => {
      for (const token of [
        "computePower", "computeThreat", "computeConfidence", "evaluateToBattlefield",
        "POWER_CONFIG", "THREAT_CONFIG", "CONFIDENCE_CONFIG",
        "classifyWallet", "walletPersona", "computeWalletScore", "battleScore",
      ]) {
        expect(src.includes(token), `world file ${rel} computes intelligence via "${token}"`).toBe(false);
      }
    });

    it(`${rel}: does not fabricate a battlefield or persona`, () => {
      // A world file must never assign power/threat score literals or invent personas.
      for (const token of ['power: { score', 'threat: { score', 'persona: "Whale"', 'persona: "Sniper"', 'persona: "Hunter"']) {
        expect(src.includes(token), `world file ${rel} fabricates data ("${token}")`).toBe(false);
      }
    });
  }
});
