import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SRC = join(HERE, "..", "..", "src");
const CORE = join(SRC, "core");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Import specifiers a core file must never reference. */
const FORBIDDEN_IMPORT_FRAGMENTS = [
  "adapters",
  "physics",
  "structure",
  "replay",
  "outcome",
  "react",
  "three",
  "pixi",
  "webgl",
  "webgpu",
  "undici",
  "node:fs",
  "node:net",
  "node:http",
];

/** Runtime tokens that break determinism — forbidden anywhere in core. */
const FORBIDDEN_RUNTIME_TOKENS = [
  "Date.now",
  "new Date(",
  "Math.random",
  "process.env",
];

/** hot_level must die at the adapter — never appear in core. */
const CORE_BANNED_FIELDS = ["hot_level", "is_open_or_close"];

function extractImports(source: string): string[] {
  const specs: string[] = [];
  const re = /(?:import|export)[^'"]*from\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    if (m[1] !== undefined) specs.push(m[1]);
  }
  return specs;
}

describe("architecture boundaries — src/core", () => {
  const coreFiles = walk(CORE);

  it("core has files to check", () => {
    expect(coreFiles.length).toBeGreaterThan(0);
  });

  for (const file of coreFiles) {
    const rel = relative(SRC, file);
    const source = readFileSync(file, "utf8");

    it(`${rel}: imports no forbidden module`, () => {
      const imports = extractImports(source);
      for (const spec of imports) {
        const lower = spec.toLowerCase();
        for (const frag of FORBIDDEN_IMPORT_FRAGMENTS) {
          expect(
            lower.includes(frag),
            `core file ${rel} imports forbidden "${spec}" (matched "${frag}")`,
          ).toBe(false);
        }
      }
    });

    it(`${rel}: contains no determinism-breaking runtime tokens`, () => {
      for (const token of FORBIDDEN_RUNTIME_TOKENS) {
        expect(
          source.includes(token),
          `core file ${rel} uses forbidden runtime token "${token}"`,
        ).toBe(false);
      }
    });

    it(`${rel}: references no adapter-only banned fields`, () => {
      for (const field of CORE_BANNED_FIELDS) {
        expect(
          source.includes(field),
          `core file ${rel} references "${field}" — must stay at adapter boundary`,
        ).toBe(false);
      }
    });
  }
});
