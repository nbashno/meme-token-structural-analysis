import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SRC = join(HERE, "..", "..", "src");
const ARENA = join(SRC, "arena");

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

describe("3 Arena architecture guard — product wiring, no intelligence", () => {
  const files = walk(ARENA);
  it("arena has files", () => { expect(files.length).toBeGreaterThan(0); });

  for (const file of files) {
    const rel = relative(SRC, file).replace(/\\/g, "/");
    const src = readFileSync(file, "utf8");

    it(`${rel}: imports no core engine / scoring config`, () => {
      const banned = ["core/power", "core/threat", "core/state/stateMachine", "core/temporal", "core/flow/flowEngine", "core/coherence/coherence", "core/features", "config/scoring", "assembleBattlefield"];
      for (const spec of imports(src)) {
        for (const b of banned) {
          expect(spec.includes(b), `arena file ${rel} imports engine "${spec}"`).toBe(false);
        }
      }
    });

    it(`${rel}: computes no intelligence and fabricates no scores/personas`, () => {
      for (const token of [
        "computePower", "computeThreat", "computeConfidence", "evaluateToBattlefield",
        "POWER_CONFIG", "THREAT_CONFIG", "battleScore", "walletScore",
        'persona: "Whale"', 'persona: "Sniper"', "power: { score", "threat: { score",
      ]) {
        expect(src.includes(token), `arena file ${rel} violates read-only via "${token}"`).toBe(false);
      }
    });
  }
});
