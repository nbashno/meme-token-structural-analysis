/**
 * WAR Product Layer — Founder Wallet event store.
 *
 * Holds the discovery snapshot (which mints the wallet currently holds) and the
 * detected events (RECEIVED, etc.). The snapshot lets us diff between ticks to
 * find NEW mints; events are dedup'd by (chain, wallet, mint, tx_hash) so a
 * given transfer notifies exactly once. No keys, no funds — bookkeeping only.
 */

export interface FounderEvent {
  readonly chain: string;
  readonly wallet: string;
  readonly eventType: "RECEIVED" | "BUY" | "SELL" | "TRANSFER" | "UNKNOWN";
  readonly tokenMint: string;
  readonly tokenSymbol: string | null;
  readonly txHash: string;
  readonly fromAddress: string | null;   // null = source unavailable (INSUFFICIENT)
  readonly fromName: string | null;
  readonly occurredAt: number | null;
  readonly detectedAt: number;
}

export interface FounderEventStore {
  /** Current known mints for a wallet (the last snapshot). */
  knownMints(chain: string, wallet: string): Promise<ReadonlySet<string>>;
  /** Record the current mint set; returns the mints that are NEW vs last snapshot. */
  updateSnapshot(chain: string, wallet: string, mints: readonly string[], nowMs: number): Promise<readonly string[]>;
  /** Record an event (idempotent by chain+wallet+mint+txHash). Returns false if already recorded. */
  recordEvent(e: FounderEvent): Promise<boolean>;
  /** Recent events for a wallet (newest first), for the UI feed. */
  recentEvents(chain: string, wallet: string, limit: number): Promise<readonly FounderEvent[]>;
}

// -- In-memory implementation ------------------------------------------------
export class InMemoryFounderEventStore implements FounderEventStore {
  private readonly snapshots = new Map<string, Set<string>>();   // `${chain}|${wallet}` -> mints
  private readonly events: FounderEvent[] = [];
  private readonly seen = new Set<string>();                     // dedup keys

  private key(chain: string, wallet: string): string { return `${chain}|${wallet}`; }

  async knownMints(chain: string, wallet: string): Promise<ReadonlySet<string>> {
    return this.snapshots.get(this.key(chain, wallet)) ?? new Set();
  }

  async updateSnapshot(chain: string, wallet: string, mints: readonly string[], _nowMs: number): Promise<readonly string[]> {
    const k = this.key(chain, wallet);
    const prev = this.snapshots.get(k) ?? new Set<string>();
    const isFirst = !this.snapshots.has(k);
    const next = new Set(mints);
    this.snapshots.set(k, next);
    // On the very first snapshot we do NOT treat everything as "new received" —
    // that would spam. We only surface mints that appear AFTER we're tracking.
    if (isFirst) return [];
    return mints.filter((m) => !prev.has(m));
  }

  async recordEvent(e: FounderEvent): Promise<boolean> {
    const dk = `${e.chain}|${e.wallet}|${e.tokenMint}|${e.txHash}`;
    if (this.seen.has(dk)) return false;
    this.seen.add(dk);
    this.events.unshift(e);
    return true;
  }

  async recentEvents(chain: string, wallet: string, limit: number): Promise<readonly FounderEvent[]> {
    return this.events.filter((e) => e.chain === chain && e.wallet === wallet).slice(0, limit);
  }
}
