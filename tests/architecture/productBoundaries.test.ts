import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SRC = join(HERE, "..", "..", "src");
const PRODUCT = join(SRC, "product");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/**
 * Product/** MUST NOT import (spec sec.61):
 *  - any renderer stack (react/three/pixi/webgl/webgpu)
 *  - the DOM
 *  - the GMGN adapter (raw payloads must never reach product directly)
 *  - the physics projector (downstream-only, visual)
 *  - node IO primitives (persistence repositories arrive in Phase 2 behind an interface)
 */
const FORBIDDEN_IMPORT_FRAGMENTS = [
  "adapters",
  "physics",
  "react",
  "three",
  "pixi",
  "webgl",
  "webgpu",
  "node:fs",
  "node:net",
  "node:http",
  "undici",
];

/**
 * Product must not RECOMPUTE WAR intelligence. It reads Core outputs. As a
 * heuristic guard, forbidden "recreate the core" function names (spec sec.3).
 */
const FORBIDDEN_INTELLIGENCE_TOKENS = [
  "productPower",
  "productThreat",
  "productConfidence",
  "productState",
  "productSignalScore",
];

/** Raw GMGN field names must never appear in product (they die at the adapter). */
const RAW_GMGN_BANNED_FIELDS = ["hot_level", "is_open_or_close"];

/** Secrets must never be referenced directly in product domain code. */
const FORBIDDEN_SECRET_TOKENS = ["process.env"];

function extractImports(source: string): string[] {
  const specs: string[] = [];
  // `import ... from "x"` / `export ... from "x"`
  const fromRe = /(?:import|export)[^'"]*from\s*['"]([^'"]+)['"]/g;
  // side-effect imports: `import "x"` (no `from`)
  const bareRe = /import\s*['"]([^'"]+)['"]/g;
  for (const re of [fromRe, bareRe]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      if (m[1] !== undefined) specs.push(m[1]);
    }
  }
  return specs;
}

describe("architecture boundaries — src/product", () => {
  const files = walk(PRODUCT);

  it("product has files to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const rel = relative(SRC, file).replace(/\\/g, "/");
    const source = readFileSync(file, "utf8");

    it(`${rel}: imports no forbidden module`, () => {
      for (const spec of extractImports(source)) {
        const lower = spec.toLowerCase();
        for (const frag of FORBIDDEN_IMPORT_FRAGMENTS) {
          expect(
            lower.includes(frag),
            `product file ${rel} imports forbidden "${spec}" (matched "${frag}")`,
          ).toBe(false);
        }
      }
    });

    it(`${rel}: does not import Core engine implementations (contracts only)`, () => {
      for (const spec of extractImports(source)) {
        // Product may import Core *types* and shared scalars/quality. It must not
        // pull engine implementation files (the calculators) into the product.
        const banned = [
          "core/power/powerEngine",
          "core/state/stateMachine",
          "core/temporal/temporalEngine",
          "core/flow/flowEngine",
          "core/trajectory/trajectory",
          "core/coherence/coherence",
          "core/novelty/novelty",
          "core/attention/attention",
          "core/events/eventDetector",
          "core/signal/signalLifecycle",
          "core/evidence/evidence",
          "replay/replay",
          "outcome/outcomeEvaluator",
        ];
        for (const b of banned) {
          expect(
            spec.includes(b),
            `product file ${rel} imports Core implementation "${spec}"`,
          ).toBe(false);
        }
      }
    });

    it(`${rel}: does not recompute WAR intelligence`, () => {
      for (const token of FORBIDDEN_INTELLIGENCE_TOKENS) {
        expect(
          source.includes(token),
          `product file ${rel} appears to recompute intelligence via "${token}"`,
        ).toBe(false);
      }
    });

    it(`${rel}: references no raw GMGN fields`, () => {
      for (const field of RAW_GMGN_BANNED_FIELDS) {
        expect(
          source.includes(field),
          `product file ${rel} references raw GMGN field "${field}"`,
        ).toBe(false);
      }
    });

    it(`${rel}: accesses no secrets directly`, () => {
      for (const token of FORBIDDEN_SECRET_TOKENS) {
        expect(
          source.includes(token),
          `product file ${rel} accesses secret token "${token}"`,
        ).toBe(false);
      }
    });

    // SQL and the pg client may ONLY appear under product/persistence/pg/**.
    // The domain, contracts, and in-memory impl must stay database-agnostic.
    const isPgLayer = rel.includes("persistence/pg/");
    // The persistence barrel is the composition seam: it re-exports both impls
    // so a composition root can pick one. Domain logic still may not touch pg.
    const isPersistenceBarrel = rel === "product/persistence/index.ts" || rel === "product/index.ts";
    if (!isPgLayer) {
      it(`${rel}: contains no raw SQL (database-agnostic)`, () => {
        const sqlSignals = ["INSERT INTO", "SELECT ", "UPDATE ", "DELETE FROM", "CREATE TABLE"];
        for (const sig of sqlSignals) {
          expect(
            source.includes(sig),
            `product file ${rel} contains SQL "${sig}" outside persistence/pg`,
          ).toBe(false);
        }
      });

      if (!isPersistenceBarrel) {
        it(`${rel}: does not import the pg client from domain code`, () => {
          for (const spec of extractImports(source)) {
            const lower = spec.toLowerCase();
            expect(
              lower === "pg" || lower.includes("/pg/pgclient") || lower.includes("/pg/pgrepositories"),
              `product file ${rel} imports pg implementation "${spec}" outside persistence/pg`,
            ).toBe(false);
          }
        });
      }
    }
  }
});
