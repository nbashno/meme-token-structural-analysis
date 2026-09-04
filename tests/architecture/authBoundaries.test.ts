import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Architecture guard — src/auth verifies identity only.
 *
 * The auth layer may use node:crypto and the domain identity types. It must NOT
 * import Core / scoring / GMGN adapters, and must NOT compute intelligence.
 * Proven load-bearing by planted-breach tests.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SRC = join(HERE, "..", "..", "src");
const AUTH = join(SRC, "auth");

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
  "../core/", "../../core/", "core/power", "core/threat",
  "config/scoring", "adapters/gmgn", "product/intelligence/report",
];
const BANNED_TOKENS = ["computePower", "computeThreat", "POWER_CONFIG", "THREAT_CONFIG", "evaluateToBattlefield", "classifyWallet"];

function offImport(src: string): string | null {
  for (const spec of imports(src)) for (const b of BANNED_IMPORTS) if (spec.includes(b)) return `${spec} ~ ${b}`;
  return null;
}
function offToken(src: string): string | null {
  for (const t of BANNED_TOKENS) if (src.includes(t)) return t;
  return null;
}

describe("auth architecture guard — identity verification only", () => {
  const files = walk(AUTH);
  it("auth layer has files", () => expect(files.length).toBeGreaterThan(0));

  for (const file of files) {
    const rel = relative(SRC, file).replace(/\\/g, "/");
    const src = readFileSync(file, "utf8");
    it(`${rel}: imports no core / scoring / gmgn`, () => {
      expect(offImport(src), `import breach in ${rel}`).toBeNull();
    });
    it(`${rel}: computes no intelligence`, () => {
      expect(offToken(src), `intelligence token in ${rel}`).toBeNull();
    });
  }
});

describe("auth guard is load-bearing — planted breaches must trip it", () => {
  it("trips on core import", () => {
    expect(offImport('import { computePower } from "../core/power/power.js";')).not.toBeNull();
  });
  it("trips on gmgn import", () => {
    expect(offImport('import { run } from "../adapters/gmgn/runner.js";')).not.toBeNull();
  });
  it("trips on intelligence token", () => {
    expect(offToken("const s = computePower(x);")).not.toBeNull();
  });
  it("passes a clean crypto line", () => {
    const clean = 'import { createHmac } from "node:crypto"; const h = createHmac("sha256", k);';
    expect(offImport(clean)).toBeNull();
    expect(offToken(clean)).toBeNull();
  });
});
