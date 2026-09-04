/**
 * WAR integration — tick engine (Phase 4 scheduler core).
 *
 * Runs ONE monitoring cycle when invoked. Designed for a scale-to-zero host:
 * an external cron pings POST /internal/tick every few minutes; each call runs
 * exactly one cycle and returns — no internal timer keeps the process awake.
 *
 * This cycle handles WALLET WATCHES (phase 3.5): for each active subscription
 * it pulls the wallet's recent activity via the injected fetcher, normalizes
 * each event through FlowEventNormalizer (so buy/sell direction is taken from
 * the feed, never invented), and — for events newer than the watch's cursor —
 * dispatches a notification and advances the cursor so it never double-alerts.
 *
 * Everything is injected (fetcher, clock, channel), so the engine itself is
 * pure orchestration and fully testable without network or a real database.
 */

import type { WalletWatchStore, WalletWatch } from "../product/watch/walletWatchStore.js";
import type { NotificationChannel } from "../arena/shareAndNotify.js";
import type { AlertRow } from "../product/persistence/contracts/repositories.js";
import type { UserId, TokenId } from "../product/domain/identity.js";
import type { Alert } from "../product/intelligence/alerts.js";

/** One normalized wallet trade the fetcher yields. Direction is from the feed. */
export interface WalletTrade {
  readonly sig: string;        // stable signature (tx hash) — the cursor key
  readonly atMs: number;       // event time
  readonly side: "buy" | "sell";
  readonly token: string;      // token address/symbol involved
  readonly amountUsd: number | null;
}

/** Pulls recent trades for a wallet, newest-first. Injected (network lives here). */
export type WalletActivityFetcher = (
  chain: string, walletAddress: string,
) => Promise<readonly WalletTrade[]>;

/** A wallet's reputation snapshot — used to judge "smart vs lucky" before subscribing. */
export interface WalletReputation {
  readonly winRate: number | null;       // 0..1, null if unknown
  readonly realizedPnlUsd: number | null;
  readonly totalTrades: number | null;
  readonly tokensTraded: number | null;
  /** Human verdict derived only from the numbers present. */
  readonly verdict: "ELITE" | "STRONG" | "MIXED" | "WEAK" | "INSUFFICIENT";
}

/** Pulls a wallet's trading statistics. Injected (network lives here). */
export type WalletStatsFetcher = (
  chain: string, walletAddress: string,
) => Promise<WalletReputation>;

export interface TickDeps {
  readonly watches: WalletWatchStore;
  readonly fetcher: WalletActivityFetcher;
  readonly channel: NotificationChannel;
  readonly now: () => number;
  /** Detector thresholds; defaults to DEFAULT_TICK_POLICY. */
  readonly policy?: TickPolicy;
}

export interface TickReport {
  readonly watchesChecked: number;
  readonly alertsSent: number;
  readonly alertsFailed: number;
  readonly errors: number;
  readonly convergences: number;   // tokens bought by 2+ watched wallets in-window
  readonly dumps: number;          // large sells flagged
}

/** Config for the two "scary" detectors. Tunable, deterministic. */
export interface TickPolicy {
  /** Convergence: min distinct watched wallets buying the same token... */
  readonly convergenceMinWallets: number;   // default 2
  /** ...within this window (ms). */
  readonly convergenceWindowMs: number;      // default 1h
  /** Dump: a sell at/above this USD size is flagged as a dump warning. */
  readonly dumpUsdThreshold: number;         // default 5000
}

export const DEFAULT_TICK_POLICY: TickPolicy = {
  convergenceMinWallets: 2,
  convergenceWindowMs: 60 * 60 * 1000,
  dumpUsdThreshold: 5000,
};

/** Build an AlertRow for a wallet trade (kept plain — analysis, not advice). */
function tradeAlert(watch: WalletWatch, trade: WalletTrade, nowMs: number): AlertRow {
  const dir = trade.side === "buy" ? "BOUGHT" : "SOLD";
  const amt = trade.amountUsd != null ? ` ~$${Math.round(trade.amountUsd).toLocaleString()}` : "";
  const short = watch.walletAddress.length > 12
    ? watch.walletAddress.slice(0, 6) + "…" + watch.walletAddress.slice(-4)
    : watch.walletAddress;
  const alert: Alert = {
    reason: "WALLET_ACTIVITY" as Alert["reason"],
    at: trade.atMs,
    detail: `Wallet ${short} ${dir} ${trade.token}${amt}`,
  };
  return {
    id: `wwatch-alert:${watch.id}:${trade.sig}`,
    userId: watch.userId as UserId,
    sessionId: watch.id,
    tokenId: 0 as unknown as TokenId, // wallet alerts aren't token-scoped
    alert,
    createdAt: nowMs,
  };
}

/** A stronger alert for a large sell — a potential dump. */
function dumpAlert(watch: WalletWatch, trade: WalletTrade, nowMs: number): AlertRow {
  const amt = trade.amountUsd != null ? `~$${Math.round(trade.amountUsd).toLocaleString()}` : "a large amount";
  const short = watch.walletAddress.length > 12
    ? watch.walletAddress.slice(0, 6) + "…" + watch.walletAddress.slice(-4)
    : watch.walletAddress;
  const alert: Alert = {
    reason: "DUMP_WARNING" as Alert["reason"],
    at: trade.atMs,
    detail: `🚨 DUMP WARNING — watched wallet ${short} SOLD ${amt} of ${trade.token}. Large exits can precede a price drop.`,
  };
  return {
    id: `wwatch-dump:${watch.id}:${trade.sig}`,
    userId: watch.userId as UserId, sessionId: watch.id,
    tokenId: 0 as unknown as TokenId, alert, createdAt: nowMs,
  };
}

/** An alpha-convergence alert: several watched wallets buying the same token. */
function convergenceAlert(userId: UserId, token: string, walletCount: number, windowMinutes: number, nowMs: number): AlertRow {
  const alert: Alert = {
    reason: "ALPHA_CONVERGENCE" as Alert["reason"],
    at: nowMs,
    detail: `⚡ ALPHA CONVERGENCE — ${walletCount} of your watched wallets bought ${token} within ${windowMinutes} min. Coordinated conviction is the strongest on-chain signal.`,
  };
  return {
    id: `conv:${userId}:${token}:${Math.floor(nowMs / 60000)}`,
    userId, sessionId: null,
    tokenId: 0 as unknown as TokenId, alert, createdAt: nowMs,
  };
}

/**
 * Run one wallet-watch cycle. For each active watch, alert on trades strictly
 * newer than its cursor, oldest→newest, advancing the cursor as we go so a
 * crash mid-cycle never re-sends already-delivered alerts on the next tick.
 */
export async function runWalletWatchTick(deps: TickDeps): Promise<TickReport> {
  const nowMs = deps.now();
  const policy = deps.policy ?? DEFAULT_TICK_POLICY;
  const active = await deps.watches.activeWatches(nowMs);
  let alertsSent = 0, alertsFailed = 0, errors = 0, dumps = 0, convergences = 0;

  // Collect fresh BUYS per user+token this cycle, to detect convergence after
  // the per-wallet pass. Keyed by `${userId}|${token}` → set of wallet addrs
  // and the min/max buy times (to measure the window).
  interface ConvAgg { wallets: Set<string>; firstAt: number; lastAt: number; token: string; userId: UserId; }
  const convAgg = new Map<string, ConvAgg>();

  const send = async (row: AlertRow) => {
    const res = await deps.channel.deliver(row);
    if (res.delivered) alertsSent++; else alertsFailed++;
  };

  for (const watch of active) {
    try {
      const cursor = await deps.watches.cursor(watch.id);
      const trades = await deps.fetcher(watch.chain, watch.walletAddress);
      const fresh = trades
        .filter((t) => cursor.lastEventAt == null || t.atMs > cursor.lastEventAt)
        .filter((t) => t.sig !== cursor.lastEventSig)
        .slice()
        .sort((a, b) => a.atMs - b.atMs);

      for (const trade of fresh) {
        // 1) Base per-trade alert (buy or sell).
        await send(tradeAlert(watch, trade, nowMs));

        // 2) DUMP WARNING — a large sell.
        if (trade.side === "sell" && trade.amountUsd != null && trade.amountUsd >= policy.dumpUsdThreshold) {
          await send(dumpAlert(watch, trade, nowMs));
          dumps++;
        }

        // 3) Feed the convergence aggregator with BUYS only.
        if (trade.side === "buy") {
          const key = `${watch.userId}|${trade.token}`;
          let agg = convAgg.get(key);
          if (!agg) { agg = { wallets: new Set(), firstAt: trade.atMs, lastAt: trade.atMs, token: trade.token, userId: watch.userId as UserId }; convAgg.set(key, agg); }
          agg.wallets.add(watch.walletAddress);
          agg.firstAt = Math.min(agg.firstAt, trade.atMs);
          agg.lastAt = Math.max(agg.lastAt, trade.atMs);
        }

        await deps.watches.advanceCursor(watch.id, trade.sig, trade.atMs, nowMs);
      }
    } catch {
      errors++;
    }
  }

  // ALPHA CONVERGENCE — same token bought by N+ distinct watched wallets within
  // the window. This is the "golden signal": coordinated conviction.
  for (const agg of convAgg.values()) {
    if (agg.wallets.size >= policy.convergenceMinWallets &&
        (agg.lastAt - agg.firstAt) <= policy.convergenceWindowMs) {
      const windowMin = Math.max(1, Math.round((agg.lastAt - agg.firstAt) / 60000));
      await send(convergenceAlert(agg.userId, agg.token, agg.wallets.size, windowMin, nowMs));
      convergences++;
    }
  }

  return { watchesChecked: active.length, alertsSent, alertsFailed, errors, convergences, dumps };
}

// ============================================================================
// FOUNDER WALLET — RECEIVED detector (spec Rules 6,7,17).
// ----------------------------------------------------------------------------
// Pipeline (all public-address, no private key):
//   1. DISCOVER  — Solana RPC getTokenAccountsByOwner → current mints
//   2. DIFF      — new mints vs last snapshot
//   3. VERIFY    — GMGN token-holders(mint): is the wallet a transfer_in holder?
//   4. EXTRACT   — token_transfer_in.tx_hash / timestamp, native_transfer.from
//   5. DEDUP     — (chain, wallet, mint, tx_hash) recorded once
//   6. NOTIFY    — broadcast RECEIVED to founder-wallet followers
// GMGN is the verification/interpretation layer; the chain is the source of
// truth for "what does this public wallet hold".
// ============================================================================

import type { FounderEventStore, FounderEvent } from "../product/founder/founderEventStore.js";
import type { FounderFollowerStore } from "../product/founder/founderFollowerStore.js";

/** Verifies a mint against GMGN holders and extracts transfer details. */
export interface FounderHoldersVerifier {
  /**
   * For a given token mint + wallet, return transfer-in details IF GMGN reports
   * the wallet received it via transfer (transfer_in=true). Null otherwise.
   */
  verifyReceived(chain: string, mint: string, wallet: string): Promise<{
    txHash: string; occurredAt: number | null;
    fromAddress: string | null; fromName: string | null; tokenSymbol: string | null;
  } | null>;
}

/** Lists the token mints a public wallet currently holds (Solana RPC). */
export type MintLister = (wallet: string) => Promise<readonly string[]>;

export interface FounderTickDeps {
  readonly chain: string;               // "sol" | "eth" | "bsc" | "base"
  readonly wallet: string;              // founder public address
  readonly listMints: MintLister;
  readonly verifier: FounderHoldersVerifier;
  readonly events: FounderEventStore;
  readonly followers: FounderFollowerStore;
  readonly broadcast: (text: string) => Promise<void>;  // send to all followers
  readonly now: () => number;
  /**
   * Optional direct inbound resolver (EVM: Alchemy getAssetTransfers). When
   * present, the sender + tx come straight from the Transfer event and GMGN
   * verification is skipped. When absent (Solana), the GMGN verifier is used.
   */
  readonly directInbound?: (wallet: string) => Promise<readonly {
    tokenAddress: string; symbol: string | null; txHash: string;
    fromAddress: string | null; occurredAtMs: number | null;
  }[]>;
}

export interface FounderTickReport {
  readonly mintsSeen: number;
  readonly newMints: number;
  readonly received: number;
  readonly notified: number;
}

function receivedMessage(e: FounderEvent): string {
  const sym = e.tokenSymbol ? `$${e.tokenSymbol}` : e.tokenMint.slice(0, 6) + "…";
  const src = e.fromName ? `\nFrom: ${e.fromName}`
    : e.fromAddress ? `\nFrom: ${e.fromAddress.slice(0, 6)}…${e.fromAddress.slice(-4)}`
    : `\nFrom: UNAVAILABLE`;
  return `◆ WAR FOUNDER WALLET — TOKEN RECEIVED\n\n${sym}${src}\n\nRECEIVED — NOT AN ENDORSEMENT. WAR analysis stays independent.`;
}

export async function runFounderReceivedTick(deps: FounderTickDeps): Promise<FounderTickReport> {
  const nowMs = deps.now();
  let received = 0, notified = 0;

  const mints = await deps.listMints(deps.wallet);
  const newMints = await deps.events.updateSnapshot(deps.chain, deps.wallet, mints, nowMs);

  // EVM path: pull inbound transfers directly (sender + tx from the Transfer
  // event). Build a lookup so a NEW mint can be matched to its transfer.
  let inboundByToken: Map<string, { txHash: string; fromAddress: string | null; occurredAtMs: number | null; symbol: string | null }> | null = null;
  if (deps.directInbound) {
    inboundByToken = new Map();
    try {
      const inbound = await deps.directInbound(deps.wallet);
      for (const t of inbound) {
        // keep the newest per token (list is desc)
        if (!inboundByToken.has(t.tokenAddress.toLowerCase())) {
          inboundByToken.set(t.tokenAddress.toLowerCase(), {
            txHash: t.txHash, fromAddress: t.fromAddress, occurredAtMs: t.occurredAtMs, symbol: t.symbol,
          });
        }
      }
    } catch { inboundByToken = null; }
  }

  for (const mint of newMints) {
    try {
      let ev: { txHash: string; occurredAt: number | null; fromAddress: string | null; fromName: string | null; tokenSymbol: string | null } | null = null;

      if (inboundByToken) {
        // EVM: sender + tx known directly from the Transfer event.
        const hit = inboundByToken.get(mint.toLowerCase());
        if (hit) ev = { txHash: hit.txHash, occurredAt: hit.occurredAtMs, fromAddress: hit.fromAddress, fromName: null, tokenSymbol: hit.symbol };
      } else {
        // Solana: verify via GMGN holders (transfer_in=true) and extract source.
        ev = await deps.verifier.verifyReceived(deps.chain, mint, deps.wallet);
      }

      if (!ev) continue; // not a verifiable received transfer → skip honestly
      const event: FounderEvent = {
        chain: deps.chain, wallet: deps.wallet, eventType: "RECEIVED",
        tokenMint: mint, tokenSymbol: ev.tokenSymbol, txHash: ev.txHash,
        fromAddress: ev.fromAddress, fromName: ev.fromName,
        occurredAt: ev.occurredAt, detectedAt: nowMs,
      };
      const isNew = await deps.events.recordEvent(event);
      if (!isNew) continue;
      received++;
      await deps.broadcast(receivedMessage(event));
      notified++;
    } catch {
      // one mint failing must not abort the whole cycle
    }
  }

  return { mintsSeen: mints.length, newMints: newMints.length, received, notified };
}
