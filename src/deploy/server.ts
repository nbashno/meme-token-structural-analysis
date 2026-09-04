/**
 * WAR deployment — server entry (the runnable main).
 *
 * Composes the live runtime and the API app, then listens. This is the top of
 * the composition tree: env -> WarRuntime (live gmgn-cli) -> ArenaSession ->
 * API router -> HTTP server. It is transport + wiring only — no intelligence.
 *
 * Kept import-safe: importing this module does NOT start a server. Call start()
 * (the bottom guard runs it only when executed as the process entry).
 */

import type { Server } from "node:http";
import { loadEnv, redactedEnv, type WarEnv } from "./env.js";
import { createWarRuntime } from "../integration/warRuntime.js";
import { GmgnCliExecutor } from "../integration/GmgnCliExecutor.js";
import { runGmgnJson } from "../adapters/gmgn/gmgnRunner.js";
import { createApp } from "../api/app.js";
import { createWiredApp } from "../api/wiredApp.js";
import { listen } from "../api/httpServer.js";
import { RateLimiter, StructuredLogger } from "../api/security.js";
import type { Chain } from "../shared/scalars.js";
import { readFileSync, existsSync } from "node:fs";
import { createPgUnitOfWork, type PgHandle } from "./persistence.js";
import { PgUsageStore } from "../product/persistence/pg/pgUsageStore.js";
import { PgReferralStore } from "../product/persistence/pg/pgReferralStore.js";
import { PgWalletWatchStore } from "../product/persistence/pg/pgWalletWatchStore.js";
import { PgFounderFollowerStore } from "../product/persistence/pg/pgFounderFollowerStore.js";
import { PgFounderEventStore } from "../product/persistence/pg/pgFounderEventStore.js";
import { SolanaRpc } from "../integration/solanaRpc.js";
import { EvmAlchemyProvider } from "../integration/evmAlchemyProvider.js";

/**
 * Minimal .env loader (zero-dependency). Reads a local `.env` file and sets any
 * keys not already present in process.env. On hosts like Koyeb the vars are
 * injected into the environment directly, so this is a no-op there — it only
 * matters for local runs. Never overrides an already-set variable.
 */
function loadDotEnv(path = ".env"): void {
  try {
    if (!existsSync(path)) return;
    const text = readFileSync(path, "utf8");
    // Collect the LAST value for each key (last definition wins), so a stray
    // earlier line (e.g. an empty template default) never shadows a real value.
    const parsed = new Map<string, string>();
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key) parsed.set(key, val); // later lines overwrite earlier ones
    }
    // Apply only the non-empty values, and only if not already in the real env.
    for (const [key, val] of parsed) {
      if (val !== "" && process.env[key] === undefined) process.env[key] = val;
    }
  } catch {
    // ignore — absence of .env is fine on hosted environments
  }
}
loadDotEnv();

/** Parse TRENDING_SEED = "sol:ADDR,bsc:ADDR" into a token list. */
function parseSeed(raw: string): readonly { chain: Chain; address: string }[] {
  return raw.split(",").map((p) => p.trim()).filter(Boolean).map((p) => {
    const [chain, address] = p.split(":");
    return { chain: (chain ?? "") as Chain, address: address ?? "" };
  }).filter((t) => t.chain && t.address);
}

export interface StartResult {
  readonly server: Server;
  readonly env: WarEnv;
}

/**
 * Build a wallet-activity fetcher backed by gmgn-cli.
 *
 * Command (verified live): `gmgn-cli portfolio activity --chain X --wallet Y
 * --type buy sell --raw`. Response shape (verified live):
 *   { activities: [ { tx_hash, timestamp, event_type: "buy"|"sell",
 *                     cost_usd, token: { address, symbol }, ... } ], next }
 *
 * We read direction from `event_type` (the feed's own buy/sell label) — never
 * inferred from is_open_or_close, which on this feed means fullness, not
 * direction (the sealed trap). Rows missing a required field are SKIPPED, never
 * guessed into a trade.
 */
function makeWalletFetcher(
  gmgnApiKey: string,
): import("../integration/tickEngine.js").WalletActivityFetcher {
  const executor = new GmgnCliExecutor(gmgnApiKey ? { apiKey: gmgnApiKey } : {});
  // The verified command tokens; overridable via env only if GMGN renames it.
  const cmd = (process.env["WALLET_ACTIVITY_CMD"] ?? "portfolio activity").trim().split(/\s+/);

  return async (chain, walletAddress) => {
    const argv = [...cmd, "--chain", chain, "--wallet", walletAddress, "--type", "buy", "sell", "--raw"];
    const res = await runGmgnJson<{ activities?: unknown[] }>(executor, argv);
    if (!res.ok) return []; // network/format error → no trades this tick (honest)

    const rows = Array.isArray(res.data?.activities) ? res.data.activities : [];
    const trades: import("../integration/tickEngine.js").WalletTrade[] = [];
    for (const row of rows) {
      const r = row as Record<string, unknown>;
      const evt = r["event_type"];
      const txh = r["tx_hash"];
      const ts = r["timestamp"];
      // Direction is the feed's explicit buy/sell label. Require the identifying
      // fields; anything missing → skip (never fabricate a trade).
      if ((evt !== "buy" && evt !== "sell") || typeof txh !== "string" || typeof ts !== "number") {
        continue;
      }
      const tok = (typeof r["token"] === "object" && r["token"] !== null) ? r["token"] as Record<string, unknown> : {};
      const tokenLabel = typeof tok["symbol"] === "string" ? tok["symbol"]
        : typeof tok["address"] === "string" ? tok["address"] : "token";
      const costRaw = r["cost_usd"];
      const cost = costRaw != null ? Number(costRaw) : NaN;
      trades.push({
        sig: txh,
        atMs: ts * 1000,          // feed timestamp is seconds → ms
        side: evt,
        token: String(tokenLabel),
        amountUsd: Number.isFinite(cost) ? cost : null,
      });
    }
    return trades;
  };
}

/**
 * Build a wallet-reputation fetcher backed by `gmgn-cli portfolio stats`.
 *
 * Returns win rate / realized PnL / trade counts so a user can judge "smart vs
 * lucky" before paying to watch a wallet. Field names are read defensively
 * (several plausible keys) and any missing metric stays null — the verdict is
 * derived ONLY from numbers actually present, never invented.
 */
function makeWalletStatsFetcher(
  gmgnApiKey: string,
): import("../integration/tickEngine.js").WalletStatsFetcher {
  const executor = new GmgnCliExecutor(gmgnApiKey ? { apiKey: gmgnApiKey } : {});
  const cmd = (process.env["WALLET_STATS_CMD"] ?? "portfolio stats").trim().split(/\s+/);

  const num = (v: unknown): number | null => {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  return async (chain, walletAddress) => {
    const argv = [...cmd, "--chain", chain, "--wallet", walletAddress, "--raw"];
    const res = await runGmgnJson<Record<string, unknown>>(executor, argv);
    if (!res.ok) {
      return { winRate: null, realizedPnlUsd: null, totalTrades: null, tokensTraded: null, verdict: "INSUFFICIENT" };
    }
    const d = res.data as Record<string, unknown>;
    // Verified live shape: root has realized_profit, buy, sell; the win rate and
    // token count live nested under pnl_stat.
    const pnlStat = (typeof d["pnl_stat"] === "object" && d["pnl_stat"] !== null)
      ? d["pnl_stat"] as Record<string, unknown> : {};

    let winRate = num(pnlStat["winrate"]);
    if (winRate != null && winRate > 1) winRate = winRate / 100;  // normalise 0..1
    const realizedPnlUsd = num(d["realized_profit"]);
    const buys = num(d["buy"]) ?? 0;
    const sells = num(d["sell"]) ?? 0;
    const totalTrades = (buys + sells) > 0 ? buys + sells : null;
    const tokensTraded = num(pnlStat["token_num"]);
    // Bonus signals for a richer verdict (present in the sealed shape).
    const bigWins = num(pnlStat["pnl_gt_5x_num"]) ?? 0;      // trades that 5x+
    const avgHoldSec = num(pnlStat["avg_holding_period"]);

    // Verdict from present numbers only. A wallet is only ELITE if its win rate
    // is high AND it traded enough distinct tokens to rule out a lucky one-hit;
    // multiple 5x+ trades strengthen an otherwise-STRONG wallet to ELITE.
    let verdict: import("../integration/tickEngine.js").WalletReputation["verdict"] = "INSUFFICIENT";
    if (winRate != null && (tokensTraded ?? 0) > 0) {
      const consistent = (tokensTraded ?? 0) >= 5;
      if (winRate >= 0.7 && consistent) verdict = "ELITE";
      else if (winRate >= 0.55 && consistent && bigWins >= 2) verdict = "ELITE";
      else if (winRate >= 0.55) verdict = "STRONG";
      else if (winRate >= 0.4) verdict = "MIXED";
      else verdict = "WEAK";
    }
    // avgHoldSec is surfaced for the UI but not part of the verdict gate.
    void avgHoldSec;
    return { winRate, realizedPnlUsd, totalTrades, tokensTraded, verdict };
  };
}

/**
 * Build a Founder-Wallet holders verifier backed by `gmgn-cli token holders`.
 *
 * Given a mint, it fetches holders (with --tag transfer_in) and looks for the
 * founder wallet. If found with transfer_in=true, it extracts the transfer tx
 * hash / timestamp / source from the verified fields (token_transfer_in and
 * native_transfer). from_address may be null → surfaced as UNAVAILABLE, never
 * invented (spec Rule 7). API-key only; no private key.
 */
function makeFounderVerifier(
  gmgnApiKey: string,
): import("../integration/tickEngine.js").FounderHoldersVerifier {
  const executor = new GmgnCliExecutor(gmgnApiKey ? { apiKey: gmgnApiKey } : {});
  return {
    async verifyReceived(chain, mint, wallet) {
      const argv = ["token", "holders", "--chain", chain, "--address", mint, "--tag", "transfer_in", "--raw", "--limit", "100"];
      const res = await runGmgnJson<{ list?: unknown[] }>(executor, argv);
      if (!res.ok) return null;
      const list = Array.isArray(res.data?.list) ? res.data.list : [];
      for (const row of list) {
        const r = row as Record<string, unknown>;
        // Match either the account_address or address to the founder wallet.
        const acct = String(r["account_address"] ?? "");
        const addr = String(r["address"] ?? "");
        if (acct !== wallet && addr !== wallet) continue;
        if (r["transfer_in"] !== true) return null; // present but not a transfer-in
        const tti = (typeof r["token_transfer_in"] === "object" && r["token_transfer_in"]) ? r["token_transfer_in"] as Record<string, unknown> : {};
        const nt = (typeof r["native_transfer"] === "object" && r["native_transfer"]) ? r["native_transfer"] as Record<string, unknown> : {};
        const txHash = String(tti["tx_hash"] ?? "");
        if (!txHash) return null; // no verifiable tx → don't fabricate an event
        const ts = tti["timestamp"];
        const fromAddr = typeof nt["from_address"] === "string" && nt["from_address"] ? nt["from_address"] as string : null;
        const fromName = typeof tti["name"] === "string" && tti["name"] ? tti["name"] as string
          : typeof nt["name"] === "string" && nt["name"] ? nt["name"] as string : null;
        return {
          txHash,
          occurredAt: typeof ts === "number" && ts > 0 ? ts * 1000 : null,
          fromAddress: fromAddr,
          fromName,
          tokenSymbol: null, // holders payload doesn't carry the mint's own symbol
        };
      }
      return null; // founder wallet not among transfer_in holders
    },
  };
}

/**
 * Build a top-traders fetcher for the WAR INTEL collector, backed by
 * `gmgn-cli token traders --order-by profit`. API-key only; extracts the
 * verified realized fields. Rows with unusable numbers are skipped (never
 * fabricated).
 */
function makeTopTradersFetcher(
  gmgnApiKey: string,
): import("../product/intel/intelBuilder.js").TopTradersFetcher {
  const executor = new GmgnCliExecutor(gmgnApiKey ? { apiKey: gmgnApiKey } : {});
  return async (chain, tokenAddress) => {
    const argv = ["token", "traders", "--chain", chain, "--address", tokenAddress,
      "--order-by", "profit", "--direction", "desc", "--raw", "--limit", "100"];
    const res = await runGmgnJson<{ list?: unknown[] }>(executor, argv);
    if (!res.ok) return [];
    const list = Array.isArray(res.data?.list) ? res.data.list : [];
    const out: { wallet: string; realizedProfit: number; realizedRoi: number | null; costUsd: number; walletTag: string | null }[] = [];
    for (const row of list) {
      const r = row as Record<string, unknown>;
      const wallet = typeof r["address"] === "string" ? r["address"] : "";
      const rp = Number(r["realized_profit"]);
      const cost = Number(r["total_cost"] ?? r["cost"]);
      if (!wallet || !Number.isFinite(rp) || !Number.isFinite(cost)) continue;
      const roiRaw = r["realized_pnl"];
      const roi = roiRaw != null && Number.isFinite(Number(roiRaw)) ? Number(roiRaw) : null;
      const tag = typeof r["wallet_tag_v2"] === "string" ? r["wallet_tag_v2"] : null;
      out.push({ wallet, realizedProfit: rp, realizedRoi: roi, costUsd: cost, walletTag: tag });
    }
    return out;
  };
}

/**
 * Fetch basic token info by address (gmgn-cli token info). Returns null if the
 * address is not a known token on that chain (so the resolver can treat it as a
 * wallet instead). API-key only.
 */
function makeTokenInfoFetcher(
  gmgnApiKey: string,
): (chain: string, address: string) => Promise<{ symbol: string | null; name: string | null; priceUsd: number | null } | null> {
  const executor = new GmgnCliExecutor(gmgnApiKey ? { apiKey: gmgnApiKey } : {});
  return async (chain, address) => {
    const res = await runGmgnJson<Record<string, unknown>>(executor, ["token", "info", "--chain", chain, "--address", address, "--raw"]);
    if (!res.ok || !res.data) return null;
    const d = res.data as Record<string, unknown>;
    // A real token payload carries a symbol/price. Empty/absent → not a token.
    const symbol = typeof d["symbol"] === "string" ? d["symbol"] : null;
    const name = typeof d["name"] === "string" ? d["name"] : null;
    const price = d["price"] != null ? Number(d["price"]) : (d["price_usd"] != null ? Number(d["price_usd"]) : null);
    if (!symbol && price == null) return null; // not a token
    return { symbol, name, priceUsd: Number.isFinite(price as number) ? price : null };
  };
}

/** Build and start the server. Returns the running server + resolved env. */
export async function start(env: WarEnv = loadEnv()): Promise<StartResult> {
  // Persistence: if DATABASE_URL is set, use Postgres (survives restarts —
  // essential under scale-to-zero). Otherwise in-memory. A configured-but-broken
  // DB throws here rather than silently degrading to volatile storage.
  let pgHandle: PgHandle | undefined;
  if (env.databaseUrl) {
    pgHandle = await createPgUnitOfWork(env.databaseUrl);
    // eslint-disable-next-line no-console
    console.log("[war-api] persistence: postgres (schema applied)");
  } else {
    // eslint-disable-next-line no-console
    console.log("[war-api] persistence: in-memory (set DATABASE_URL for durable storage)");
  }

  // Notification channel: real Telegram delivery when we have both a bot token
  // and a database to resolve chat ids from; otherwise the honest no-op channel.
  let notificationChannel: import("../arena/shareAndNotify.js").NotificationChannel | undefined;
  if (env.telegramBotToken && pgHandle) {
    const { TelegramNotificationChannel } = await import("../integration/telegramChannel.js");
    const pool = pgHandle.pool;
    notificationChannel = new TelegramNotificationChannel({
      botToken: env.telegramBotToken,
      // Resolve the opaque domain userId back to the Telegram id stored at auth.
      resolveChatId: async (userId: import("../product/domain/identity.js").UserId) => {
        const r = await pool.query<{ provider_user_id: string }>(
          "SELECT provider_user_id FROM users WHERE id = $1", [userId],
        );
        return r.rows[0]?.provider_user_id ?? null;
      },
    });
  }

  // Live executor picks up GMGN_API_KEY from env at call time.
  const runtime = createWarRuntime({
    cliExecutor: new GmgnCliExecutor(env.gmgnApiKey ? { apiKey: env.gmgnApiKey } : {}),
    ...(pgHandle ? { uow: pgHandle.uow, usageStore: new PgUsageStore(pgHandle.pool), referralStore: new PgReferralStore(pgHandle.pool), walletWatchStore: new PgWalletWatchStore(pgHandle.pool), founderFollowerStore: new PgFounderFollowerStore(pgHandle.pool) } : {}),
    ...(notificationChannel ? { notificationChannel } : {}),
    ...(env.freeUntil ? { freeUntil: env.freeUntil } : {}),
    ...(env.requiredChannel ? { requiredChannel: env.requiredChannel } : {}),
    ...(env.telegramBotToken ? { botToken: env.telegramBotToken } : {}),
    ...(env.trendingTtlHours ? { trendingTtlMs: Number(env.trendingTtlHours) * 3600_000 } : {}),
    ...(env.trendingSeed ? { trendingSeed: parseSeed(env.trendingSeed) } : {}),
  });

  // If a bot token is configured, serve the fully wired API (auth + billing +
  // consent + webhooks). Without one, fall back to the base (public) app so the
  // server still boots for health checks and local inspection.
  const walletFetcher = env.gmgnApiKey ? makeWalletFetcher(env.gmgnApiKey) : undefined;
  const walletStatsFetcher = env.gmgnApiKey ? makeWalletStatsFetcher(env.gmgnApiKey) : undefined;

  // Founder RECEIVED detection, per chain. All public-address; no private key.
  const founderTicks: NonNullable<import("../api/wiredApp.js").WiredConfig["founderTicks"]>[number][] = [];
  if (env.gmgnApiKey && pgHandle && env.telegramBotToken) {
    const eventStore = new PgFounderEventStore(pgHandle.pool);
    const followerStore = new PgFounderFollowerStore(pgHandle.pool);
    const pool = pgHandle.pool;
    const botToken = env.telegramBotToken;
    const broadcast = async (text: string) => {
      const ids = await followerStore.followerChatIds(pool);
      for (const chatId of ids) {
        try {
          await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
          });
        } catch { /* one failed send must not stop the rest */ }
      }
    };
    // Solana — discovery via RPC, verify via GMGN holders.
    if (env.solanaRpcUrl && env.founderWalletSol) {
      const rpc = new SolanaRpc({ rpcUrl: env.solanaRpcUrl });
      founderTicks.push({
        chain: "sol", wallet: env.founderWalletSol,
        listMints: (w) => rpc.tokenMintsOf(w),
        verifier: makeFounderVerifier(env.gmgnApiKey),
        events: eventStore, broadcast,
      });
    }
    // EVM (eth/bsc/base share the 0x address) — discovery + inbound via Alchemy.
    if (env.alchemyEthUrl && env.founderWalletEvm) {
      const evm = new EvmAlchemyProvider({ chain: "eth", rpcUrl: env.alchemyEthUrl });
      founderTicks.push({
        chain: "eth", wallet: env.founderWalletEvm,
        listMints: async (w) => (await evm.listAssets(w)).map((a) => a.tokenAddress),
        verifier: makeFounderVerifier(env.gmgnApiKey), // unused on EVM (directInbound wins)
        events: eventStore, broadcast,
        directInbound: (w) => evm.recentInbound!(w),
      });
    }
  }

  const app = env.telegramBotToken
    ? createWiredApp(runtime, {
        auth: { botToken: env.telegramBotToken },
        ...(env.tickSecret ? { tickSecret: env.tickSecret } : {}),
        ...(env.adminTelegramIds ? { adminTelegramIds: new Set(env.adminTelegramIds.split(",").map(s=>s.trim()).filter(Boolean)) } : {}),
        ...(walletFetcher ? { walletFetcher } : {}),
        ...(walletStatsFetcher ? { walletStatsFetcher } : {}),
        ...(env.gmgnApiKey ? { tokenInfoFetcher: makeTokenInfoFetcher(env.gmgnApiKey) } : {}),
        ...(founderTicks.length ? { founderTicks } : {}),
        ...(env.gmgnApiKey ? { intelCollector: { fetchTopTraders: makeTopTradersFetcher(env.gmgnApiKey) } } : {}),
      })
    : createApp(runtime.arena);

  // Security stack: rate limit, CORS, security headers, structured logging.
  const logger = new StructuredLogger(
    (line) => { console.log(line); }, // eslint-disable-line no-console
    env.nodeEnv === "production" ? "info" : "debug",
  );
  const rateLimiter = new RateLimiter({ capacity: 60, refillPerSecond: 1 }); // ~60 burst, 1/s sustained
  const server = listen(app, env.port, env.host, {
    rateLimiter,
    logger,
    securityHeaders: true,
    ...(env.corsOrigin ? { cors: { allowOrigin: env.corsOrigin } } : {}),
  });

  // Startup log — redacted (never prints secret values).
  // eslint-disable-next-line no-console
  console.log("[war-api] listening", JSON.stringify(redactedEnv(env)));

  installGracefulShutdown(server);
  return { server, env };
}

function installGracefulShutdown(server: Server): void {
  const close = (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`[war-api] ${signal} received, closing`);
    server.close(() => process.exit(0));
    // Force-exit if close hangs.
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGTERM", () => close("SIGTERM"));
  process.on("SIGINT", () => close("SIGINT"));
}

// Run only when executed directly (not on import). ESM-safe entry check.
const isEntry = (() => {
  try {
    const arg = process.argv[1] ?? "";
    return import.meta.url === `file://${arg}` || import.meta.url.endsWith(arg.replace(/\\/g, "/"));
  } catch {
    return false;
  }
})();

if (isEntry) {
  start().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[war-api] failed to start:", err);
    process.exit(1);
  });
}
