/**
 * WAR Product Layer — trending cache for the arena.
 *
 * The arena's opening view is "the top battles right now": a set of tokens the
 * user sees without searching. This layer supplies that set and keeps it fresh
 * WITHOUT a background loop — which matters on scale-to-zero hosts (a timer in a
 * sleeping process never fires). Instead it refreshes LAZILY: the first request
 * after the TTL expires triggers one refresh; everyone else in the window is
 * served the cached snapshot instantly. So GMGN is hit at most once per TTL no
 * matter how many users open the arena.
 *
 * DISCIPLINE — address source is separated from metric acquisition:
 *   - `AddressSource` returns WHICH tokens are trending (a list of {chain,address}).
 *   - The caller evaluates each through the real scan path to get its WorldState.
 * We do NOT assume GMGN's `trending` returns addresses (the sealed RawTrending
 * carries metrics, not an address). Until that is confirmed from the sealed
 * source, the default AddressSource is an explicit, configurable seed list. When
 * a real trending-address endpoint is confirmed, swap the source in one place —
 * nothing else changes.
 */

import type { Chain } from "../../shared/scalars.js";

export interface TrendingToken {
  readonly chain: Chain;
  readonly address: string;
}

/**
 * Where the trending ADDRESS LIST comes from. Deterministic + injectable:
 * production wires a confirmed source; tests pass a stub; the safe default is a
 * configured seed list. Returns null on failure so the cache can keep serving
 * its last good snapshot (never throws the arena into an empty state).
 */
export type AddressSource = () => Promise<readonly TrendingToken[] | null>;

/** A ready-to-serve snapshot: opaque per-token payloads the caller produced. */
export interface TrendingSnapshot<T> {
  readonly generatedAt: number;
  readonly tokens: readonly T[];
  /** True when this snapshot is a stale fallback (refresh failed). */
  readonly stale: boolean;
}

export interface TrendingConfig {
  /** Time-to-live in milliseconds before a snapshot is considered old. */
  readonly ttlMs: number;
}

/** 4 hours, per the launch decision. Configurable via env at the composition root. */
export const DEFAULT_TRENDING_TTL_MS = 4 * 60 * 60 * 1000;

/**
 * Generic lazy cache. `T` is whatever per-token payload the caller builds
 * (here: a WorldState-shaped view). The cache itself knows nothing about
 * WorldState — it only orchestrates freshness + fan-out safety.
 */
export class TrendingCache<T> {
  private snapshot: TrendingSnapshot<T> | null = null;
  private inFlight: Promise<TrendingSnapshot<T>> | null = null;

  constructor(
    private readonly cfg: TrendingConfig,
    private readonly source: AddressSource,
    /** Build one token's payload from its {chain,address}. Caller supplies the real scan path. */
    private readonly evaluate: (t: TrendingToken, now: number) => Promise<T | null>,
  ) {}

  /** Whether the current snapshot is missing or older than the TTL. */
  isStale(now: number): boolean {
    if (this.snapshot === null) return true;
    return now - this.snapshot.generatedAt >= this.cfg.ttlMs;
  }

  /**
   * Get the trending snapshot. Serves cache when fresh. When stale, refreshes
   * once — concurrent callers during a refresh share the single in-flight
   * promise (no thundering herd, so GMGN sees one burst, not one-per-user).
   * If a refresh fails, the last good snapshot is returned marked `stale`;
   * only when there has never been a snapshot does it return an empty one.
   */
  async get(now: number): Promise<TrendingSnapshot<T>> {
    if (!this.isStale(now) && this.snapshot !== null) return this.snapshot;
    if (this.inFlight !== null) return this.inFlight;

    this.inFlight = this.refresh(now).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async refresh(now: number): Promise<TrendingSnapshot<T>> {
    let addresses: readonly TrendingToken[] | null;
    try {
      addresses = await this.source();
    } catch {
      addresses = null;
    }

    // Source failed → serve last good snapshot as stale, or an empty one.
    if (addresses === null) {
      if (this.snapshot !== null) {
        this.snapshot = { ...this.snapshot, stale: true };
        return this.snapshot;
      }
      return { generatedAt: now, tokens: [], stale: true };
    }

    // Evaluate each token through the real path. Failures drop that token
    // (never fabricate); a token with no data simply doesn't appear.
    const tokens: T[] = [];
    for (const addr of addresses) {
      try {
        const payload = await this.evaluate(addr, now);
        if (payload !== null) tokens.push(payload);
      } catch {
        // drop this token; keep going
      }
    }

    this.snapshot = { generatedAt: now, tokens, stale: false };
    return this.snapshot;
  }
}

/**
 * The safe default address source: an explicit, configurable seed list of real
 * token addresses. This is honest — it doesn't claim to be GMGN-ranked; it's the
 * set the operator chose to feature until a confirmed trending-address feed is
 * wired. Empty list is valid (arena shows an honest "no trending yet" state).
 */
export function seedAddressSource(seed: readonly TrendingToken[]): AddressSource {
  const copy = seed.map((t) => ({ chain: t.chain, address: t.address }));
  return async () => copy;
}
