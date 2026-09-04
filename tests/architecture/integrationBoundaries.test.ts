import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SRC = join(HERE, "..", "..", "src");
const INTEGRATION = join(SRC, "integration");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

function extractImports(source: string): string[] {
  const specs: string[] = [];
  const fromRe = /(?:import|export)[^'"]*from\s*['"]([^'"]+)['"]/g;
  const bareRe = /import\s*['"]([^'"]+)['"]/g;
  for (const re of [fromRe, bareRe]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) if (m[1] !== undefined) specs.push(m[1]);
  }
  return specs;
}

describe("5B-C/5B-E architecture — src/integration", () => {
  const files = walk(INTEGRATION);

  it("integration layer has files", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const rel = relative(SRC, file).replace(/\\/g, "/");
    const source = readFileSync(file, "utf8");

    // 5B-E: integration must NOT fabricate intelligence. It wires; it does not
    // compute or inject Power/Threat/Confidence/BattlefieldState. It may REFERENCE
    // the types (imports) but must not import the scoring config or construct
    // scored outputs, and must not recompute intelligence.
    it(`${rel}: does not import scoring config (no intelligence tuning)`, () => {
      for (const spec of extractImports(source)) {
        expect(
          spec.includes("config/scoring"),
          `integration file ${rel} imports scoring config "${spec}"`,
        ).toBe(false);
      }
    });

    it(`${rel}: does not recompute WAR intelligence`, () => {
      for (const token of ["productPower", "productThreat", "productConfidence", "computePower(", "computeThreat(", "computeConfidence("]) {
        expect(
          source.includes(token),
          `integration file ${rel} recomputes intelligence via "${token}"`,
        ).toBe(false);
      }
    });

    it(`${rel}: does not construct fake battlefield/power/threat literals`, () => {
      // A fabricated intelligence object would assign a numeric score literal to
      // power/threat/confidence. The real path only ever passes through the core
      // evaluator's output. Guard against obvious injection shapes.
      for (const token of ["power: {", "threat: {", "battlefield: {", "tokens: ["]) {
        expect(
          source.includes(token),
          `integration file ${rel} appears to fabricate intelligence ("${token}")`,
        ).toBe(false);
      }
    });

    it(`${rel}: only RealWarEvaluationPort delegates to the core evaluator`, () => {
      // evaluateToBattlefield is the ONLY core-intelligence entry integration may
      // CALL, and only from the evaluation port file. Match the call form so a
      // doc-comment mention elsewhere is not a false positive.
      if (source.includes("evaluateToBattlefield(")) {
        expect(rel).toBe("integration/RealWarEvaluationPort.ts");
      }
    });
  }

  it("5B-C: the core boundary law still forbids core -> adapters (GMGN) elsewhere", () => {
    // This is asserted by tests/architecture/boundaries.test.ts; here we just
    // confirm the integration layer is the seam by checking it DOES import both.
    const acq = readFileSync(join(INTEGRATION, "RealGmgnAcquisitionPort.ts"), "utf8");
    const imports = extractImports(acq).join(" ");
    expect(imports).toContain("adapters/gmgn"); // integration may touch GMGN
    expect(imports).toContain("product/scan/ports"); // and product contracts
  });
});
