/**
 * WAR API — wired app (the connective layer).
 *
 * This is the piece the production audit flagged as the #1 gap: it connects the
 * already-built layers through HTTP. On top of the base routes it:
 *   - enforces Telegram auth on protected routes (401 without valid initData),
 *   - registers a user + grants the free quota on first contact,
 *   - gates protected routes on current consent (409 until agreed),
 *   - charges the BalanceLedger for a scan (free quota first, then balance),
 *     refunding on failure so a failed scan never costs the user,
 *   - exposes GET /me (account profile) and POST /consent (durable agreement),
 *   - accepts Stars/TON payment webhooks and settles them to balance.
 *
 * It holds no intelligence; it is authorization + accounting wiring only. Auth
 * is injected (bot token) so tests can drive it deterministically.
 */

import type { WarRuntime } from "../integration/warRuntime.js";
import type { ApiRequest } from "./router.js";
import { Router } from "./router.js";
import type { HttpResponse } from "./httpResult.js";
import * as handlers from "./handlers.js";
import { authenticate, extractInitData, type AuthConfig } from "../auth/authMiddleware.js";
import type { UserId } from "../product/domain/identity.js";
import { CURRENT_LEGAL_VERSION } from "../product/legal/consent.js";
import { DEFAULT_REFERRAL_POLICY } from "../product/referral/referralStore.js";
import { WATCH_TIERS, watchTierOf } from "../product/pricing/pricing.js";
import { usd as usdMicros } from "../product/domain/identity.js";
import { runWalletWatchTick } from "../integration/tickEngine.js";
import { runFounderReceivedTick } from "../integration/tickEngine.js";
import { buildBriefing, type IntelBriefing } from "../product/intel/intelBuilder.js";
import { collectObservations } from "../product/intel/intelBuilder.js";
import { TelegramStarsVerifier, TonVerifier, type AuthenticityCheck } from "../product/payment/railVerifiers.js";

export interface WiredConfig {
  readonly auth: AuthConfig;
  /** Authenticity checks for payment rails (real network verify at deploy). */
  readonly starsAuthentic?: AuthenticityCheck;
  readonly tonAuthentic?: AuthenticityCheck;
  /** Clock for consent timestamps / auth freshness. */
  readonly now?: () => number;
  /** Shared secret guarding POST /internal/tick (external cron calls it). */
  readonly tickSecret?: string;
  /** Telegram IDs (set) with unlimited free admin access — bypass quotas/pay. */
  readonly adminTelegramIds?: ReadonlySet<string>;
  /** Pulls a wallet's recent trades for the tick engine (network lives here). */
  readonly walletFetcher?: import("../integration/tickEngine.js").WalletActivityFetcher;
  /** Pulls a wallet's reputation stats (win rate / PnL) for the reputation endpoint. */
  readonly walletStatsFetcher?: import("../integration/tickEngine.js").WalletStatsFetcher;
  /** Resolves a token address to basic info (for the unified /resolve search). */
  readonly tokenInfoFetcher?: (chain: string, address: string) => Promise<{ symbol: string | null; name: string | null; priceUsd: number | null } | null>;
  /** Founder RECEIVED detection deps, one per chain. Optional. */
  readonly founderTicks?: ReadonlyArray<{
    readonly chain: string;
    readonly wallet: string;
    readonly listMints: import("../integration/tickEngine.js").MintLister;
    readonly verifier: import("../integration/tickEngine.js").FounderHoldersVerifier;
    readonly events: import("../product/founder/founderEventStore.js").FounderEventStore;
    readonly broadcast: (text: string) => Promise<void>;
    readonly directInbound?: (wallet: string) => Promise<readonly {
      tokenAddress: string; symbol: string | null; txHash: string;
      fromAddress: string | null; occurredAtMs: number | null;
    }[]>;
  }>;
  /** WAR INTEL collector: pulls top traders per trending token into the store. */
  readonly intelCollector?: {
    readonly fetchTopTraders: import("../product/intel/intelBuilder.js").TopTradersFetcher;
  };
}

function json(status: number, body: unknown): HttpResponse {
  return { status, body };
}

export function createWiredApp(runtime: WarRuntime, cfg: WiredConfig): Router {
  const router = new Router();
  const now = cfg.now ?? (() => runtime.clock.now());
  let opSeq = 0; // monotonic per-process counter so op ids are unique even when
                 // the injected clock is fixed (tests) or coarse.

  // WAR INTEL briefing cache — short TTL so opening the app is instant.
  const INTEL_TTL_MS = 3 * 60 * 1000; // 3 minutes
  let intelCache: { at: number; briefing: IntelBriefing } | null = null;

  // ---- public routes (no auth) ----
  router.get("/health", () => handlers.health());
  router.get("/capabilities", () => handlers.capabilities());

  // ---- GET /trending — the arena's "top battles" view (public, free browse) ----
  // Serves the cached snapshot; refreshes lazily at most once per TTL. No auth,
  // no consent, no charge — browsing the arena is open to everyone.
  router.get("/trending", async () => {
    const snap = await runtime.trending.get(now());
    return json(200, { ok: true, generatedAt: snap.generatedAt, stale: snap.stale, tokens: snap.tokens });
  });

  // ---- GET /war/intel — the pre-Arena intelligence briefing ---------------
  // Builds cards from accumulated REAL performance observations + the live
  // trending snapshot. Cached with a short TTL so opening the app is instant
  // and GMGN is not hit per-user. No auth required (public discovery surface).
  router.get("/war/intel", async () => {
    const nowMs = now();
    if (intelCache && (nowMs - intelCache.at) < INTEL_TTL_MS) {
      return json(200, { ok: true, cached: true, ...intelCache.briefing });
    }
    // Fresh build: trending snapshot → refs, then calibrated briefing.
    const snap = await runtime.trending.get(nowMs);
    const refs = (snap.tokens ?? []).map((t) => {
      const st = (t as { stats?: { symbol?: string; change1h?: number | null } }).stats;
      return {
        chain: (t as { chain: string }).chain,
        address: (t as { address: string }).address,
        symbol: st?.symbol ?? null,
        priceChange1hPct: (st && typeof st.change1h === "number") ? st.change1h : null,
      };
    });
    const briefing = await buildBriefing(runtime.perfObservations, refs, nowMs);
    intelCache = { at: nowMs, briefing };
    return json(200, { ok: true, cached: false, ...briefing });
  });
  function auth(req: ApiRequest): { userId: UserId; telegramId: string } | { fail: HttpResponse } {
    const initData = extractInitData(req.headers ?? {}, req.body, req.query);
    const nowSec = Math.floor(now() / 1000);
    const res = authenticate(cfg.auth, { initData, nowSeconds: nowSec, nowMillis: now() });
    if (!res.ok) return { fail: json(res.status, { ok: false, error: res.error }) };
    // Ensure the account exists + free grant on first contact.
    runtime.balances.register(res.identity.userId, now());
    return { userId: res.identity.userId, telegramId: res.identity.providerUserId };
  }

  // Admin bypass: listed Telegram IDs get unlimited free access — no quota,
  // no payment, no tier caps, no channel gate. For the operator / owner.
  function isAdmin(telegramId: string): boolean {
    return !!cfg.adminTelegramIds && cfg.adminTelegramIds.has(telegramId);
  }

  // ---- consent gate: 409 until the user has agreed to the current version ----
  function consentOk(userId: UserId): HttpResponse | null {
    if (runtime.consent.isCurrent(userId)) return null;
    return json(409, { ok: false, error: "consent required", needsConsent: true, version: CURRENT_LEGAL_VERSION });
  }

  // ---- GET /me — account profile (auth required) ----
  router.get("/me", async (req) => {
    const a = auth(req);
    if ("fail" in a) return a.fail;
    const profile = await runtime.account.profile(a.userId, now());
    const consent = runtime.consent.status(a.userId);
    const promotion = runtime.promotion.status(now());
    const membership = { enabled: runtime.membership.isEnabled() };
    return json(200, { ok: true, profile, consent, promotion, membership });
  });

  // ---- POST /consent — record durable agreement (auth required) ----
  router.post("/consent", (req) => {
    const a = auth(req);
    if ("fail" in a) return a.fail;
    const body = (typeof req.body === "object" && req.body !== null ? req.body : {}) as Record<string, unknown>;
    const version = typeof body["version"] === "string" ? body["version"] : CURRENT_LEGAL_VERSION;
    const source = typeof body["source"] === "string" ? body["source"] : "miniapp";
    const rec = runtime.consent.record(a.userId, version, now(), source);
    return json(200, { ok: true, recorded: rec, isCurrent: runtime.consent.isCurrent(a.userId) });
  });

  // Persist the user row (id + telegram provider id) so the notification
  // channel can later resolve a chat id from the opaque domain userId. Safe to
  // call repeatedly (upsert). Best-effort: never blocks the request path.
  async function ensureUserPersisted(userId: UserId, telegramId: string): Promise<void> {
    try {
      await runtime.uow.repos.users.upsert({
        userId, provider: "TELEGRAM", providerUserId: telegramId, createdAt: now(),
      });
    } catch { /* non-fatal: notifications will fall back to NO_CHAT_ID */ }
  }

  // ---- Founder Wallet follow (no wallet connection needed; spec Rule 5) ----
  router.get("/founder", async (req) => {
    const a = auth(req);
    if ("fail" in a) return a.fail;
    const st = await runtime.founderFollowers.status(a.userId);
    return json(200, { ok: true, ...st });
  });
  router.post("/founder/follow", async (req) => {
    const a = auth(req);
    if ("fail" in a) return a.fail;
    await ensureUserPersisted(a.userId, a.telegramId);
    const st = await runtime.founderFollowers.follow(a.userId, now());
    return json(200, { ok: true, ...st });
  });
  router.post("/founder/unfollow", async (req) => {
    const a = auth(req);
    if ("fail" in a) return a.fail;
    const st = await runtime.founderFollowers.unfollow(a.userId);
    return json(200, { ok: true, ...st });
  });

  // ---- GET /referral — my invite code + progress (auth required) ----
  router.get("/referral", async (req) => {
    const a = auth(req);
    if ("fail" in a) return a.fail;
    const prog = await runtime.referrals.progress(a.userId, DEFAULT_REFERRAL_POLICY, now());
    const pending = await runtime.referrals.pendingRewards(a.userId, DEFAULT_REFERRAL_POLICY, now());
    return json(200, { ok: true, referral: prog, pendingRewards: pending.length,
      invitesPerReward: DEFAULT_REFERRAL_POLICY.invitesPerReward });
  });

  // ---- POST /referral/claim — attribute this user to an inviter's code ----
  // Called once when a new user opens the app via someone's invite link. Safe
  // to call repeatedly: double-attribution is a no-op (invitee is unique).
  router.post("/referral/claim", async (req) => {
    const a = auth(req);
    if ("fail" in a) return a.fail;
    const body = (typeof req.body === "object" && req.body !== null ? req.body : {}) as Record<string, unknown>;
    const code = typeof body["code"] === "string" ? body["code"].trim() : "";
    if (!code) return json(400, { ok: false, error: "code is required" });
    const recorded = await runtime.referrals.recordInvite(code, a.userId, now());
    return json(200, { ok: true, recorded });
  });

  // ---- POST /referral/rewards — grant any earned-but-unpaid rewards --------
  // Each milestone (every N invites) grants ONE free 24h monitor entitlement.
  // Idempotent: markGranted gates on (referrer, milestone), so a reward is
  // never issued twice even if this is called repeatedly or concurrently.
  router.post("/referral/rewards", async (req) => {
    const a = auth(req);
    if ("fail" in a) return a.fail;
    const pending = await runtime.referrals.pendingRewards(a.userId, DEFAULT_REFERRAL_POLICY, now());
    const granted: number[] = [];
    for (const p of pending) {
      const rewardRef = `referral:${a.userId}:m${p.milestone}`;
      // Claim the milestone first (idempotent). Only if WE won the claim do we
      // issue the entitlement — this prevents a concurrent double-grant.
      const won = await runtime.referrals.markGranted(a.userId, p.milestone, rewardRef, now());
      if (!won) continue;
      const internalPayment = {
        intentId: rewardRef, providerTxId: rewardRef, rail: "TELEGRAM_STARS" as const,
        status: "VERIFIED" as const, verifiedAt: now(), amountUsd: 0 as never,
      };
      const ent = runtime.entitlements.issueFrom(internalPayment, a.userId, "TOKEN_MONITOR_24H", null);
      if (ent.ok) {
        await runtime.uow.repos.entitlements.issue(ent.value);
        granted.push(p.milestone);
      }
    }
    return json(200, { ok: true, grantedMilestones: granted, count: granted.length });
  });

  // ---- GET /wallet-reputation — judge a wallet before watching it ---------
  // Returns win rate / PnL / verdict so the user knows if a wallet is smart or
  // just lucky. Read-only, auth required. Honest: unknown metrics stay null.
  router.get("/wallet-reputation", async (req) => {
    const a = auth(req);
    if ("fail" in a) return a.fail;
    if (!cfg.walletStatsFetcher) {
      return json(200, { ok: true, reputation: null, note: "reputation lookup not configured" });
    }
    const q = (req.query ?? {}) as Record<string, string>;
    const chain = typeof q["chain"] === "string" ? q["chain"] : "";
    const walletAddress = typeof q["wallet"] === "string" ? q["wallet"].trim() : "";
    if (!chain || !walletAddress) {
      return json(400, { ok: false, error: "chain and wallet query params are required" });
    }
    const reputation = await cfg.walletStatsFetcher(chain, walletAddress);
    return json(200, { ok: true, reputation });
  });

  // ---- GET /wallet-watch — my subscriptions + tier + quota ----------------
  router.get("/wallet-watch", async (req) => {
    const a = auth(req);
    if ("fail" in a) return a.fail;
    const watches = await runtime.walletWatch.forUser(a.userId);
    const tierId = await runtime.walletWatch.tierOf(a.userId, now());
    const plan = watchTierOf(tierId);
    const used = await runtime.walletWatch.activeCountForUser(a.userId, now());
    return json(200, { ok: true, watches, tier: plan.tier, maxWallets: plan.maxWallets,
      used, tiers: Object.values(WATCH_TIERS) });
  });

  // ---- POST /wallet-watch/subscribe — buy or change a watch tier ----------
  // Charges the tier's monthly price (free during promo), then unlocks the
  // wallet quota. Watching wallets within the quota is free (see POST below).
  router.post("/wallet-watch/subscribe", async (req) => {
    const a = auth(req);
    if ("fail" in a) return a.fail;
    await ensureUserPersisted(a.userId, a.telegramId);
    const gate = consentOk(a.userId);
    if (gate) return gate;
    const body = (typeof req.body === "object" && req.body !== null ? req.body : {}) as Record<string, unknown>;
    const tierId = typeof body["tier"] === "string" ? body["tier"] : "";
    const plan = watchTierOf(tierId);
    if (plan.tier === "FREE") {
      await runtime.walletWatch.setTier(a.userId, "FREE", now(), 0);
      return json(200, { ok: true, tier: "FREE", maxWallets: plan.maxWallets });
    }
    const opId = `wtier:${a.userId}:${now()}:${++opSeq}`;
    const price = usdMicros(plan.priceUsd);
    const free = runtime.promotion.isFree(now());
    if (!free) {
      const charge = runtime.balances.charge(a.userId, opId, price, now(), { allowFree: true });
      if (!charge.ok) return json(402, { ok: false, error: charge.error, needsTopUp: true });
    }
    await runtime.walletWatch.setTier(a.userId, plan.tier, now(), 30 * 24 * 3600 * 1000);
    return json(200, { ok: true, tier: plan.tier, maxWallets: plan.maxWallets });
  });

  // ---- POST /wallet-watch — add a wallet (free within the tier quota) -----
  router.post("/wallet-watch", async (req) => {
    const a = auth(req);
    if ("fail" in a) return a.fail;
    await ensureUserPersisted(a.userId, a.telegramId);
    const gate = consentOk(a.userId);
    if (gate) return gate;
    const body = (typeof req.body === "object" && req.body !== null ? req.body : {}) as Record<string, unknown>;
    const chain = typeof body["chain"] === "string" ? body["chain"] : "";
    const walletAddress = typeof body["walletAddress"] === "string" ? body["walletAddress"].trim() : "";
    if (!chain || !walletAddress) {
      return json(400, { ok: false, error: "chain and walletAddress are required" });
    }
    // Quota check against the user's tier (admins are unlimited).
    const tierId = await runtime.walletWatch.tierOf(a.userId, now());
    const plan = watchTierOf(tierId);
    const used = await runtime.walletWatch.activeCountForUser(a.userId, now());
    if (!isAdmin(a.telegramId) && used >= plan.maxWallets) {
      return json(402, { ok: false, error: "WALLET_QUOTA_REACHED", tier: plan.tier,
        maxWallets: plan.maxWallets, needsUpgrade: true });
    }
    const opId = `wwatch:${a.userId}:${now()}:${++opSeq}`;
    // An entitlement records the grant (free within quota); no charge here.
    const internalPayment = {
      intentId: opId, providerTxId: opId, rail: "TELEGRAM_STARS" as const,
      status: "VERIFIED" as const, verifiedAt: now(), amountUsd: usdMicros(0),
    };
    const ent = runtime.entitlements.issueFrom(internalPayment, a.userId, "WALLET_WATCH_MONTHLY", null);
    if (!ent.ok) return json(500, { ok: false, error: "could not issue entitlement" });
    await runtime.uow.repos.entitlements.issue(ent.value);
    const watch = await runtime.walletWatch.subscribe({
      id: opId, userId: a.userId, chain: chain as never, walletAddress,
      entitlementId: ent.value.id, nowMs: now(),
    });
    return json(200, { ok: true, watch, used: used + 1, maxWallets: plan.maxWallets });
  });

  // ---- DELETE-style cancel — POST /wallet-watch/cancel --------------------
  router.post("/wallet-watch/cancel", async (req) => {
    const a = auth(req);
    if ("fail" in a) return a.fail;
    const body = (typeof req.body === "object" && req.body !== null ? req.body : {}) as Record<string, unknown>;
    const watchId = typeof body["watchId"] === "string" ? body["watchId"] : "";
    if (!watchId) return json(400, { ok: false, error: "watchId is required" });
    const cancelled = await runtime.walletWatch.cancel(a.userId, watchId);
    return json(200, { ok: true, cancelled });
  });

  // ---- POST /internal/tick — run ONE monitoring cycle (cron-driven) -------
  // Guarded by a shared secret so only the external scheduler can invoke it.
  // Runs one wallet-watch cycle and returns a report. Designed for scale-to-zero:
  // the host sleeps between cron pings; each ping does exactly one cycle.
  router.post("/internal/tick", async (req) => {
    if (!cfg.tickSecret) return json(503, { ok: false, error: "tick not configured" });
    const headers = (req.headers ?? {}) as Record<string, string>;
    const provided = headers["x-tick-secret"] ?? headers["X-Tick-Secret"] ?? "";
    if (provided !== cfg.tickSecret) return json(401, { ok: false, error: "unauthorized" });

    // Fire-and-forget: kick off the cycle but respond immediately so the
    // external cron never hits its response-time limit. Each phase is isolated
    // (one failure never aborts the others); results are logged, not returned.
    void runTickCycle().catch(() => { /* logged inside */ });
    return json(202, { ok: true, accepted: true });
  });

  // The actual work, run in the background after the tick endpoint responds.
  async function runTickCycle(): Promise<void> {
    const errors: Record<string, string> = {};

    if (cfg.walletFetcher) {
      try {
        await runWalletWatchTick({
          watches: runtime.walletWatch, fetcher: cfg.walletFetcher,
          channel: runtime.notificationChannel, now,
        });
      } catch (e) { errors["walletWatch"] = (e as Error).message; }
    }

    for (const ft of cfg.founderTicks ?? []) {
      try {
        await runFounderReceivedTick({
          chain: ft.chain, wallet: ft.wallet, listMints: ft.listMints,
          verifier: ft.verifier, events: ft.events, followers: runtime.founderFollowers,
          broadcast: ft.broadcast,
          ...(ft.directInbound ? { directInbound: ft.directInbound } : {}),
          now,
        });
      } catch (e) { errors[`founder:${ft.chain}`] = (e as Error).message; }
    }

    if (cfg.intelCollector) {
      try {
        const snap = await runtime.trending.get(now());
        const refs = (snap.tokens ?? []).map((t) => {
          const st = (t as { stats?: { symbol?: string; change1h?: number | null } }).stats;
          return {
            chain: (t as { chain: string }).chain,
            address: (t as { address: string }).address,
            symbol: st?.symbol ?? null,
            priceChange1hPct: (st && typeof st.change1h === "number") ? st.change1h : null,
          };
        });
        await collectObservations(
          { store: runtime.perfObservations, fetchTopTraders: cfg.intelCollector.fetchTopTraders, now },
          refs,
        );
      } catch (e) { errors["intel"] = (e as Error).message; }
    }

    if (Object.keys(errors).length) {
      // eslint-disable-next-line no-console
      console.warn("[war-api] tick phase errors:", JSON.stringify(errors));
    }
  }

  // ---- POST /scan — auth + consent + charge (free first, then balance) ----
  router.post("/scan", async (req) => {
    const a = auth(req);
    if ("fail" in a) return a.fail;
    const gate = consentOk(a.userId);
    if (gate) return gate;

    // Channel membership gate — required for operations (browsing stays open).
    const admin = isAdmin(a.telegramId);
    const member = admin ? { allowed: true } : await runtime.membership.check(a.userId, a.telegramId);
    if (!member.allowed) {
      return json(403, { ok: false, error: "channel membership required", joinChannel: (member as { channel?: string }).channel, reason: (member as { reason?: string }).reason });
    }

    const body = (typeof req.body === "object" && req.body !== null ? req.body : {}) as Record<string, unknown>;
    const token = body["token"];
    if (typeof token !== "object" || token === null) {
      return json(400, { ok: false, error: "token { chain, address } is required" });
    }

    const price = runtime.pricing.priceOf("TOKEN_SCAN");
    const opId = `scan:${a.userId}:${now()}:${++opSeq}`;

    // Per-user daily cap (by tier) — protects free resources, applies ALWAYS
    // (even during the promo window). COMMAND (null cap) is unlimited.
    const acct = runtime.balances.get(a.userId);
    const tier = acct?.tier ?? "STANDARD";
    const dailyScans = runtime.pricing.tierLimits(tier).dailyScans;
    const cap = admin ? { allowed: true, retryAtMs: null } : await runtime.usage.check(a.userId, "scan", dailyScans, now());
    if (!cap.allowed) {
      return json(429, { ok: false, error: "daily scan limit reached", retryAtMs: cap.retryAtMs });
    }

    // Launch free window: everything is free while active. We still issue an
    // entitlement (the pipeline needs one) but skip the balance charge, and
    // there is nothing to refund on failure.
    const free = runtime.promotion.isFree(now()) || admin;
    let chargedSource: string;
    if (free) {
      chargedSource = admin ? "ADMIN" : "PROMO";
    } else {
      const charge = runtime.balances.charge(a.userId, opId, price, now(), { allowFree: true });
      if (!charge.ok) return json(402, { ok: false, error: charge.error, needsTopUp: true });
      chargedSource = charge.value.source;
    }

    // The paid charge issues a one-shot execution ticket (entitlement) that the
    // scan pipeline consumes. opId is the idempotency key for both layers.
    const internalPayment = {
      intentId: opId,
      providerTxId: opId,
      rail: "TELEGRAM_STARS" as const,
      status: "VERIFIED" as const,
      verifiedAt: now(),
      amountUsd: price,
    };
    const ent = runtime.entitlements.issueFrom(internalPayment, a.userId, "TOKEN_SCAN", null);
    if (!ent.ok) {
      if (!free) runtime.balances.refund(a.userId, opId, now());
      return json(500, { ok: false, error: "could not issue entitlement" });
    }
    // Mirror the entitlement into the persistence repo, since the scan pipeline
    // updates its status there (the ledger guards consumption; the repo stores
    // the row). Both share the id ent:<opId>.
    await runtime.uow.repos.entitlements.issue(ent.value);

    // Build the full scan body the base handler expects, then run it.
    const scanReq: ApiRequest = {
      ...req,
      body: {
        requestId: opId,
        userId: a.userId,
        token,
        entitlementId: ent.value.id,
        position: body["position"] ?? { x: 0, y: 0 },
      },
    };
    const result = await handlers.scan(runtime.arena, scanReq);
    if (result.status >= 400) {
      if (!free) runtime.balances.refund(a.userId, opId, now());
      return result;
    }
    await runtime.usage.record(a.userId, "scan", now()); // count only successful scans
    return json(result.status, addMeta(result.body, { charged: chargedSource, opId }));
  });

  // ---- authenticated reads ----
  router.get("/search", async (req) => {
    const a = auth(req);
    if ("fail" in a) return a.fail;
    return handlers.search(runtime.arena, req);
  });

  // ---- GET /resolve — unified address search across all WAR chains ----------
  // Paste ANY token or wallet address; we detect which chain + whether it's a
  // token (returns token info) or a wallet (returns reputation). This is the
  // real crypto search: by address, live from GMGN, any of the 4 chains.
  router.get("/resolve", async (req) => {
    const a = auth(req);
    if ("fail" in a) return a.fail;
    const q = (req.query ?? {}) as Record<string, string>;
    const address = typeof q["address"] === "string" ? q["address"].trim() : "";
    if (!address) return json(400, { ok: false, error: "address is required" });

    // Chain family from address shape: 0x… = EVM (eth/bsc/base), else Solana.
    const isEvm = address.startsWith("0x") && address.length === 42;
    const chains = isEvm ? ["eth", "bsc", "base"] : ["sol"];

    // 1) Try as a TOKEN on each candidate chain (first hit wins).
    if (cfg.tokenInfoFetcher) {
      for (const chain of chains) {
        try {
          const info = await cfg.tokenInfoFetcher(chain, address);
          if (info && (info.symbol || info.priceUsd != null)) {
            return json(200, { ok: true, kind: "token", chain, address,
              symbol: info.symbol, name: info.name, priceUsd: info.priceUsd });
          }
        } catch { /* try next chain */ }
      }
    }

    // 2) Not a token → treat as a WALLET; return reputation on the first chain
    //    that yields data (or the primary chain guess).
    if (cfg.walletStatsFetcher) {
      for (const chain of chains) {
        try {
          const rep = await cfg.walletStatsFetcher(chain, address);
          if (rep && rep.verdict !== "INSUFFICIENT") {
            return json(200, { ok: true, kind: "wallet", chain, address, reputation: rep });
          }
        } catch { /* try next chain */ }
      }
      // Even if reputation is thin, it's still a wallet address — return it so
      // the user can watch it.
      return json(200, { ok: true, kind: "wallet", chain: chains[0], address, reputation: null });
    }

    return json(200, { ok: true, kind: "unknown", chain: chains[0], address });
  });
  router.get("/replay/:sessionId", async (req) => {
    const a = auth(req);
    if ("fail" in a) return a.fail;
    return handlers.replay(runtime.arena, req);
  });

  // ---- payment webhooks (provider-authenticated, not user-authenticated) ----
  const starsVerifier = new TelegramStarsVerifier(cfg.starsAuthentic ?? (() => false));
  const tonVerifier = new TonVerifier(cfg.tonAuthentic ?? (() => false));

  router.post("/webhook/stars", (req) => {
    const r = runtime.payments.handleWebhook(starsVerifier, req.body);
    return r.ok ? json(200, { ok: true, settlement: r.value }) : json(400, { ok: false, error: r.error });
  });
  router.post("/webhook/ton", (req) => {
    const r = runtime.payments.handleWebhook(tonVerifier, req.body);
    return r.ok ? json(200, { ok: true, settlement: r.value }) : json(400, { ok: false, error: r.error });
  });

  return router;
}

/** Attach small metadata to a successful JSON body without losing its shape. */
function addMeta(body: unknown, meta: Record<string, unknown>): unknown {
  if (typeof body === "object" && body !== null && !Array.isArray(body)) {
    return { ...(body as Record<string, unknown>), _meta: meta };
  }
  return { data: body, _meta: meta };
}
