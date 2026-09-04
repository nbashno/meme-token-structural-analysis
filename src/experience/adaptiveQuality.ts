/**
 * WAR experience — adaptive quality (Phase A / A4).
 *
 * Presentation-ONLY quality adaptation. It chooses how many particles and which
 * secondary effects to draw based on MEASURED frame time. It NEVER alters:
 *   intelligence · state · score · data.
 *
 * The tier changes only what the GPU draws, never what the engine computes.
 * Pure and Node-testable: measurement is injected, not read from ambient time.
 */

export type QualityTier = "ULTRA" | "HIGH" | "MEDIUM" | "LOW";

export interface QualityBudget {
  readonly tier: QualityTier;
  /** Max particles per world (presentation cap). */
  readonly particlesPerWorld: number;
  /** Whether restrained glow/secondary effects are drawn. */
  readonly secondaryEffects: boolean;
  /** Whether non-focused worlds draw beyond minimal LOD hints. */
  readonly detailOffFocus: boolean;
}

const BUDGETS: Record<QualityTier, QualityBudget> = {
  ULTRA: { tier: "ULTRA", particlesPerWorld: 64, secondaryEffects: true, detailOffFocus: true },
  HIGH: { tier: "HIGH", particlesPerWorld: 32, secondaryEffects: true, detailOffFocus: true },
  MEDIUM: { tier: "MEDIUM", particlesPerWorld: 16, secondaryEffects: false, detailOffFocus: true },
  LOW: { tier: "LOW", particlesPerWorld: 4, secondaryEffects: false, detailOffFocus: false },
};

export function budgetFor(tier: QualityTier): QualityBudget {
  return BUDGETS[tier];
}

/**
 * Choose a tier from a measured average frame time (ms). Targets ~60fps.
 * Thresholds are presentational, not intelligence. Hysteresis is applied by the
 * caller (see `adaptTier`) to avoid flicker between tiers.
 */
export function tierForFrameTime(avgFrameMs: number): QualityTier {
  if (!Number.isFinite(avgFrameMs) || avgFrameMs <= 0) return "HIGH";
  if (avgFrameMs <= 12) return "ULTRA"; // ~83fps headroom
  if (avgFrameMs <= 18) return "HIGH"; // ~55-83fps
  if (avgFrameMs <= 28) return "MEDIUM"; // ~36-55fps
  return "LOW"; // < ~36fps
}

/**
 * Step the tier toward the frame-time target with one-step hysteresis so we
 * never oscillate. Pure: current tier in, next tier out.
 */
export function adaptTier(current: QualityTier, avgFrameMs: number): QualityTier {
  const order: readonly QualityTier[] = ["LOW", "MEDIUM", "HIGH", "ULTRA"];
  const target = tierForFrameTime(avgFrameMs);
  const ci = order.indexOf(current);
  const ti = order.indexOf(target);
  if (ti === ci) return current;
  // move exactly one step toward target (hysteresis)
  const next = ti > ci ? ci + 1 : ci - 1;
  return order[next] ?? current;
}

/**
 * A tiny rolling frame-time meter. Deterministic: you push measured deltas; it
 * reports the moving average. No ambient clock is read here.
 */
export class FrameMeter {
  private readonly samples: number[] = [];
  constructor(private readonly window = 30) {}

  push(deltaMs: number): void {
    if (!Number.isFinite(deltaMs) || deltaMs < 0) return;
    this.samples.push(deltaMs);
    if (this.samples.length > this.window) this.samples.shift();
  }

  average(): number {
    if (this.samples.length === 0) return 0;
    let sum = 0;
    for (const s of this.samples) sum += s;
    return sum / this.samples.length;
  }

  reset(): void {
    this.samples.length = 0;
  }
}
