/**
 * WAR experience — GPU capability detection (Phase A / A1).
 *
 * Detects the ACTUAL rendering backend available in the current browser at
 * runtime. It NEVER claims WebGPU support before a real detection has run: the
 * result is `UNKNOWN` until `detectCapability` executes against real browser
 * globals. In non-browser environments (Node) it resolves to a headless-safe
 * `UNAVAILABLE` verdict rather than fabricating a GPU.
 *
 * This module contains ZERO intelligence. It only inspects the environment.
 */

/** The renderer backend actually selected after detection. */
export type RendererBackend = "webgpu" | "webgl2" | "unavailable";

/** Detection verdict — `pending` before detection has been run. */
export type CapabilityVerdict = "pending" | RendererBackend;

export interface Capability {
  /** Chosen backend, or `unavailable` if neither WebGPU nor WebGL2 exists. */
  readonly backend: RendererBackend;
  /** True only if a real `navigator.gpu` was observed (not assumed). */
  readonly webgpuDetected: boolean;
  /** True only if a real WebGL2 context was obtained. */
  readonly webgl2Detected: boolean;
  /** Capped device pixel ratio actually read from the environment. */
  readonly devicePixelRatio: number;
  /** Human-readable note for the HUD/report. Never a fabricated metric. */
  readonly note: string;
}

/**
 * The environment surface we inspect. Injected so this is testable in Node
 * without touching real browser globals. In the browser, `detectFromWindow`
 * builds this from the real `navigator`/`document`.
 */
export interface CapabilityEnv {
  readonly hasNavigatorGpu: boolean;
  /** Attempts to obtain a WebGL2 context; returns true only if one is real. */
  readonly canGetWebgl2: () => boolean;
  readonly devicePixelRatio: number;
}

/** Cap DPR for performance; presentation-only, never affects data. */
const MAX_DPR = 2;

/**
 * Pure detection over an injected environment. Deterministic and Node-testable.
 * Preference order: WebGPU (if reliably present) → WebGL2 fallback → unavailable.
 */
export function detectCapability(env: CapabilityEnv): Capability {
  const dpr = clampDpr(env.devicePixelRatio);

  if (env.hasNavigatorGpu) {
    return {
      backend: "webgpu",
      webgpuDetected: true,
      webgl2Detected: env.canGetWebgl2(),
      devicePixelRatio: dpr,
      note: "WebGPU available (navigator.gpu present).",
    };
  }

  if (env.canGetWebgl2()) {
    return {
      backend: "webgl2",
      webgpuDetected: false,
      webgl2Detected: true,
      devicePixelRatio: dpr,
      note: "WebGPU absent; using WebGL2 fallback.",
    };
  }

  return {
    backend: "unavailable",
    webgpuDetected: false,
    webgl2Detected: false,
    devicePixelRatio: dpr,
    note: "No GPU backend detected (headless or unsupported environment).",
  };
}

function clampDpr(dpr: number): number {
  if (!Number.isFinite(dpr) || dpr <= 0) return 1;
  return Math.min(MAX_DPR, dpr);
}

/**
 * Browser-only helper: builds a real `CapabilityEnv` from window globals and
 * runs detection. Guarded so it is safe to *call* in Node (returns `unavailable`
 * without throwing), but it performs no work unless real globals exist.
 */
export function detectFromWindow(): Capability {
  const g = globalThis as unknown as {
    navigator?: { gpu?: unknown };
    document?: { createElement?(tag: string): unknown };
    devicePixelRatio?: number;
  };

  const hasNavigatorGpu = typeof g.navigator?.gpu !== "undefined";
  const devicePixelRatio = typeof g.devicePixelRatio === "number" ? g.devicePixelRatio : 1;

  const canGetWebgl2 = (): boolean => {
    try {
      const create = g.document?.createElement;
      if (typeof create !== "function") return false;
      const canvas = create.call(g.document, "canvas") as {
        getContext?(id: string): unknown;
      };
      return typeof canvas.getContext === "function" && canvas.getContext("webgl2") != null;
    } catch {
      return false;
    }
  };

  return detectCapability({ hasNavigatorGpu, canGetWebgl2, devicePixelRatio });
}
