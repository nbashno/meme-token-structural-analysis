/**
 * WAR Product Layer — promotion policy (launch free window).
 *
 * A fixed-date promotional period during which ALL paid operations (scan,
 * monitor) are free for everyone, regardless of balance or quota. After the
 * cutoff the normal billing path resumes automatically — nothing to toggle.
 *
 * Deliberately a THIN layer over the money logic: it does not touch the
 * BalanceLedger or pricing (both tested + sealed). The wired API asks
 * `isFree(now)` before charging; when true, it skips the charge entirely.
 *
 * Deterministic: the cutoff is injected (from env at deploy), and `isFree`
 * takes an explicit `now`. No ambient clock, no intelligence.
 */

export interface PromotionConfig {
  /**
   * Unix millis at/after which the free window is OVER. Operations are free
   * strictly while now < freeUntilMs. If undefined, there is no promotion
   * (normal billing applies immediately).
   */
  readonly freeUntilMs: number | undefined;
}

export class PromotionPolicy {
  constructor(private readonly cfg: PromotionConfig) {}

  /** True while the launch free window is active. */
  isFree(nowMs: number): boolean {
    return this.cfg.freeUntilMs !== undefined && nowMs < this.cfg.freeUntilMs;
  }

  /** The cutoff (millis), or null if no promotion is configured. */
  freeUntil(): number | null {
    return this.cfg.freeUntilMs ?? null;
  }

  /**
   * A small status object for the UI/account so the app can honestly show
   * "free until <date>" and stop showing it once the window closes.
   */
  status(nowMs: number): { active: boolean; freeUntilMs: number | null; msRemaining: number } {
    const until = this.cfg.freeUntilMs;
    if (until === undefined) return { active: false, freeUntilMs: null, msRemaining: 0 };
    const active = nowMs < until;
    return { active, freeUntilMs: until, msRemaining: active ? until - nowMs : 0 };
  }
}

/**
 * Parse a promotion cutoff from an env string. Accepts an ISO date
 * (e.g. "2026-10-01" or a full ISO timestamp). Returns undefined for an
 * empty/absent/invalid value — i.e. "no promotion", never a wrong date.
 */
export function parseFreeUntil(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : undefined;
}
