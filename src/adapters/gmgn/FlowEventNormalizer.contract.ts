/**
 * WAR — FlowEventNormalizer Contract
 * ----------------------------------
 * TYPES + CONTRACT ONLY. No implementation. No runtime logic.
 *
 * Authority: GMGNAI/gmgn-skills @ 147c070c502a9fe3ff845595db61a066a543161c
 * Sealed by: PHASE_0_SEALED.md (correction #2, #3)
 *
 * PURPOSE
 * The raw GMGN field `is_open_or_close` carries TWO categorically different
 * meanings depending on which track sub-command produced the event. The raw
 * value MUST NOT enter the WAR core. This contract defines the boundary at
 * which raw flow events are converted into a single, source-tagged, normalized
 * PositionEvent — and, crucially, defines what CANNOT be derived per source.
 *
 * HARD RULE (from repo, gmgn-track/SKILL.md):
 *   follow-wallet:  is_open_or_close encodes FULLNESS, not direction.
 *                     1 = full position event (open OR close)
 *                     0 = partial event (add OR reduce)
 *                   Direction comes from `side`. Combine the two.
 *   kol/smartmoney: is_open_or_close encodes DIRECTION, not fullness.
 *                     0 = opened / added
 *                     1 = closed / reduced
 *                   Fullness is UNKNOWN. It is FORBIDDEN to synthesize
 *                   FULL_OPEN / FULL_CLOSE for these sources.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Source identity — the branch key. Never inferred; always known at ingest.
// ─────────────────────────────────────────────────────────────────────────────

export type FlowSource = "follow-wallet" | "kol" | "smartmoney";

export type TradeSide = "buy" | "sell";

/** Raw is_open_or_close as returned by the CLI — passthrough, uninterpreted. */
export type RawOpenOrClose = 0 | 1;

// ─────────────────────────────────────────────────────────────────────────────
// Raw event shapes — deliberately source-specific (correction #3).
// These mirror the repo schemas; fields absent from a source are absent here.
// ─────────────────────────────────────────────────────────────────────────────

/** Fields common to every track source (verified across all three schemas). */
interface RawFlowEventCommon {
  readonly transaction_hash: string;
  readonly maker: string;
  readonly side: TradeSide;
  readonly base_address: string;
  readonly amount_usd: string;
  readonly price_usd: string;
  readonly buy_cost_usd: string;
  readonly is_open_or_close: RawOpenOrClose;
  readonly timestamp: number;
  readonly maker_info: { readonly tags: readonly string[] };
}

/** follow-wallet-only fields (not present on kol/smartmoney). */
export interface RawFollowWalletEvent extends RawFlowEventCommon {
  readonly __source: "follow-wallet";
  readonly quote_address: string;
  readonly base_amount: string;
  readonly quote_amount: string;
  readonly price_change: string;
  readonly price_now: string;
  readonly maker_info: {
    readonly tags: readonly string[];
    readonly tag_rank?: Readonly<Record<string, number>>;
  };
}

/** kol / smartmoney fields. `token_amount` exists here, NOT on follow-wallet. */
export interface RawKolSmartMoneyEvent extends RawFlowEventCommon {
  readonly __source: "kol" | "smartmoney";
  readonly token_amount: string;
}

export type RawFlowEvent = RawFollowWalletEvent | RawKolSmartMoneyEvent;

// ─────────────────────────────────────────────────────────────────────────────
// Normalized output — the ONLY flow shape the core may consume.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PositionEvent classification.
 *
 * FULL_* / PARTIAL_* are derivable ONLY from follow-wallet (fullness + side).
 * OPEN_OR_ADD / CLOSE_OR_REDUCE are the ONLY classifications kol/smartmoney
 * can produce (direction known, fullness unknown).
 * UNKNOWN is a valid, first-class outcome — never a silent default to zero.
 */
export type PositionEvent =
  // derivable from follow-wallet only:
  | "FULL_OPEN"
  | "FULL_CLOSE"
  | "PARTIAL_ADD"
  | "PARTIAL_REDUCE"
  // the ceiling of what kol/smartmoney can express:
  | "OPEN_OR_ADD"
  | "CLOSE_OR_REDUCE"
  // explicit unknown — carries no fabricated information:
  | "UNKNOWN";

/** Whether fullness is known. kol/smartmoney is permanently UNKNOWN fullness. */
export type Fullness = "FULL" | "PARTIAL" | "UNKNOWN";

/** Direction after normalization (open-side vs close-side of a position). */
export type PositionDirection = "OPEN" | "CLOSE" | "UNKNOWN";

export interface NormalizedFlowEvent {
  readonly source: FlowSource;
  readonly transactionHash: string;
  readonly maker: string;
  readonly side: TradeSide;
  readonly baseAddress: string;
  readonly amountUsd: string;
  readonly priceUsd: string;
  readonly timestamp: number;
  readonly tags: readonly string[];

  /** Normalized classification. The raw is_open_or_close is NOT carried through. */
  readonly positionEvent: PositionEvent;
  readonly fullness: Fullness;
  readonly direction: PositionDirection;

  /**
   * Provenance guard: proves the raw bit was interpreted under the correct
   * source rule. The core may assert on this; it may never see the raw bit.
   */
  readonly interpretedUnder: FlowSource;
}

// ─────────────────────────────────────────────────────────────────────────────
// Contract surface — signatures only. Implementation lands in Phase 5.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The normalizer boundary. Pure, total, deterministic.
 *
 * INVARIANTS (to be enforced by property tests in Phase 5, per V3.2 §19/§48):
 *  I1. A kol/smartmoney event can NEVER yield FULL_OPEN, FULL_CLOSE,
 *      PARTIAL_ADD, or PARTIAL_REDUCE. (fullness is UNKNOWN there.)
 *  I2. A follow-wallet event with is_open_or_close===1 yields FULL_*,
 *      with ===0 yields PARTIAL_*, direction taken from `side`.
 *  I3. The raw is_open_or_close value appears in NO field of the output.
 *  I4. `interpretedUnder === source` always. No cross-source interpretation.
 *  I5. Missing/malformed input yields UNKNOWN — never a fabricated FULL/PARTIAL,
 *      never a coerced 0.
 */
export interface FlowEventNormalizer {
  normalize(raw: RawFlowEvent): NormalizedFlowEvent;
}

/**
 * Compile-time proof of I1: this mapping deliberately excludes every FULL and
 * PARTIAL classification from the kol/smartmoney branch. Kept as a type-level
 * ceiling so a future edit that tries to add one fails to typecheck.
 */
export type KolSmartMoneyCeiling = Extract<
  PositionEvent,
  "OPEN_OR_ADD" | "CLOSE_OR_REDUCE" | "UNKNOWN"
>;

export type FollowWalletCeiling = Extract<
  PositionEvent,
  "FULL_OPEN" | "FULL_CLOSE" | "PARTIAL_ADD" | "PARTIAL_REDUCE" | "UNKNOWN"
>;
