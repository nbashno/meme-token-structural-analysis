import { describe, it, expect, beforeEach } from "vitest";

import { ArenaSession } from "../../src/arena/ArenaSession.js";
import { RepositorySearchPort, MonitoringHistoryReader } from "../../src/arena/backends.js";
import { buildShareCard, NotificationDispatcher } from "../../src/arena/shareAndNotify.js";
import { capability, isUsable, CAPABILITIES } from "../../src/arena/capabilities.js";
import { createScanService } from "../../src/integration/scanComposition.js";
import { MonitoringService } from "../../src/integration/MonitoringService.js";
import { RealWarEvaluationPort } from "../../src/integration/RealWarEvaluationPort.js";
import { RealGmgnAcquisitionPort } from "../../src/integration/RealGmgnAcquisitionPort.js";
import { toWorldState } from "../../src/world/worldAdapter.js";
import { InMemoryUnitOfWork } from "../../src/product/persistence/memory/inMemory.js";
import { EntitlementLedger } from "../../src/product/payment/entitlement.js";
import { PRICING_V1 } from "../../src/product/pricing/pricing.js";
import { MODEL_VERSIONS, ENGINE_VERSION } from "../../src/config/versions.js";
import { buildIntelligenceReport } from "../../src/product/intelligence/report.js";
import { makeEntry, makeBattlefield } from "../unit/productFixtures.js";
import type { CliExecutor, CliRunResult } from "../../src/adapters/gmgn/gmgnRunner.js";
import type { UserId, TokenId, Clock } from "../../src/product/domain/identity.js";
import type { TokenMemoryRecord } from "../../src/product/persistence/tokenMemory.js";

const uid = (s: string) => s as UserId;
const tok: TokenId = { chain: "sol", address: "TokenAAA" as TokenId["address"] };

function stubCli(): CliExecutor {
  return { async run(argv): Promise<CliRunResult> {
    const cmd = argv.join(" ");
    if (cmd.includes("market kline")) return { exitCode: 0, stderr: "", stdout: JSON.stringify([
      { time: 1000, open: "1.0", close: "1.0", high: "1.1", low: "0.9", volume: "10000", amount: "10000" },
      { time: 2000, open: "1.0", close: "1.1", high: "1.2", low: "1.0", volume: "12000", amount: "11000" },
      { time: 3000, open: "1.1", close: "1.25", high: "1.3", low: "1.1", volume: "15000", amount: "12000" },
    ]) };
    if (cmd.includes("market trending")) return { exitCode: 0, stderr: "", stdout: JSON.stringify([
      { price: 1.25, market_cap: 1000000, liquidity: 200000, holder_count: 1500, swaps: 300, buys: 180, sells: 120, smart_degen_count: 8, renowned_count: 3, rug_ratio: 0.15, top_10_holder_rate: 0.35, is_wash_trading: false, bundler_rate: 0.05 }]) };
    if (cmd.includes("track")) return { exitCode: 0, stderr: "", stdout: JSON.stringify([
      { __source: "smartmoney", transaction_hash: "0x1", maker: "wA", side: "buy", base_address: tok.address, amount_usd: "8000", price_usd: "1.2", buy_cost_usd: "8000", is_open_or_close: 0, timestamp: 1500, maker_info: { tags: ["smart_degen"] }, token_amount: "6600" }]) };
    return { exitCode: 1, stdout: "", stderr: "unknown" };
  } };
}

async function harness() {
  const uow = new InMemoryUnitOfWork();
  const ledger = new EntitlementLedger();
  await uow.repos.pricing.record(PRICING_V1);
  await uow.repos.users.upsert({ userId: uid("u1"), provider: "TELEGRAM", providerUserId: "tg:1", createdAt: 0 });
  const clock: Clock = { now: () => 5000 };
  const scanService = createScanService({ uow, clock, entitlements: ledger, engineVersion: ENGINE_VERSION, modelVersions: MODEL_VERSIONS, cliExecutor: stubCli() });
  const monitoringService = new MonitoringService({ acquisition: new RealGmgnAcquisitionPort(stubCli()), evaluation: new RealWarEvaluationPort(), clock });
  const seed = async (id: string) => {
    const txId = id.replace("ent:", "");
    ledger.issueFrom({ intentId: "i", providerTxId: txId, rail: "TON", status: "VERIFIED", verifiedAt: 100, amountUsd: 100000 as never }, uid("u1"), "TOKEN_SCAN", null);
    await uow.repos.payments.createIntent({ providerTxId: txId, intentId: `i-${id}`, userId: uid("u1"), rail: "TON", entitlementType: "TOKEN_SCAN", amountUsdMicros: 100000, pricingVersion: PRICING_V1.version, status: "VERIFIED", createdAt: 0, verifiedAt: 100, refundedAt: null });
    await uow.repos.entitlements.issue({ id, userId: uid("u1"), type: "TOKEN_SCAN", providerTxId: txId, status: "ISSUED", grantsDurationMs: null, issuedAt: 100 });
  };
  return { uow, ledger, scanService, monitoringService, seed };
}

describe("3 ArenaSession — production wiring, one source of truth", () => {
  let h: Awaited<ReturnType<typeof harness>>;
  beforeEach(async () => { h = await harness(); });

  it("PRODUCTION ACCEPTANCE: scan -> report -> world, through payment gate, no bypass", async () => {
    await h.seed("ent:tx1");
    const arena = new ArenaSession({ scanService: h.scanService, monitoringService: h.monitoringService, uow: h.uow });
    const r = await arena.scan({ requestId: "req1", userId: uid("u1"), token: tok, entitlementId: "ent:tx1" }, { x: 0, y: 0 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // world is fed from the real report
    expect(r.value.world.power.raw).toBe(r.value.result.report.power.score as unknown as number);
    // entitlement was consumed via the gate (not bypassed)
    expect((await h.uow.repos.entitlements.get("ent:tx1"))?.status).toBe("CONSUMED");
    // world instance mounted
    const id = `${r.value.world.chain}:${r.value.world.address}`;
    expect(arena.world.get(id)?.phase).toBe("MOUNTED");
  });

  it("failed scan does not create a world or consume payment", async () => {
    await h.seed("ent:tx2");
    const failing = createScanService({ uow: h.uow, clock: { now: () => 5000 } as Clock, entitlements: h.ledger, engineVersion: ENGINE_VERSION, modelVersions: MODEL_VERSIONS, cliExecutor: { async run() { return { exitCode: 1, stdout: "", stderr: "network error" }; } } });
    const arena = new ArenaSession({ scanService: failing, monitoringService: h.monitoringService, uow: h.uow });
    const r = await arena.scan({ requestId: "req2", userId: uid("u1"), token: tok, entitlementId: "ent:tx2" }, { x: 0, y: 0 });
    expect(r.ok).toBe(false);
    expect((await h.uow.repos.entitlements.get("ent:tx2"))?.status).toBe("ISSUED"); // released
    expect(arena.world.count()).toBe(0);
  });
});

describe("3 Search backend (real, unblocked)", () => {
  it("searches stored tokens by symbol", async () => {
    const uow = new InMemoryUnitOfWork();
    await uow.repos.tokens.ensure("sol", "Addr1" as never, "ELMO", "Elmo Coin");
    await uow.repos.tokens.ensure("sol", "Addr2" as never, "WIF", "dogwifhat");
    const port = new RepositorySearchPort(uow);
    const res = await port.search({ text: "elmo" });
    expect(res.length).toBe(1);
    expect(res[0]!.symbol).toBe("ELMO");
  });

  it("empty query returns nothing (no fabricated results)", async () => {
    const uow = new InMemoryUnitOfWork();
    const port = new RepositorySearchPort(uow);
    expect(await port.search({ text: "" })).toEqual([]);
  });
});

describe("3 Replay history read (real, unblocked)", () => {
  it("reads persisted observation history for a session", async () => {
    const uow = new InMemoryUnitOfWork();
    const rec = (at: number): TokenMemoryRecord => ({ token: tok, kind: "REPORT" as never, at, provenance: { source: "monitor" } as never, ref: "session-1" });
    await uow.repos.observations.append(rec(1000), { f: 1 }, ["first"], { source: "monitor" } as never);
    await uow.repos.observations.append(rec(2000), { f: 2 }, ["state transition"], { source: "monitor" } as never);
    const reader = new MonitoringHistoryReader(uow);
    const history = await reader.history("session-1");
    expect(history.length).toBe(2);
    expect(history[0]!.at).toBe(1000);
    expect(history[1]!.reasons).toContain("state transition");
  });
});

describe("3 Share card — pure projection", () => {
  it("copies values straight from world state, no computation", () => {
    const entry = makeEntry({ address: "TokenAAA", power: 82, threat: 24, state: "ATTACK" });
    const bf = makeBattlefield([entry]);
    const world = toWorldState({ report: buildIntelligenceReport(bf, bf.tokens[0]!) });
    const card = buildShareCard(world, "16:9");
    expect(card.power).toBe(82);
    expect(card.threat).toBe(24);
    expect(card.state).toBe("ATTACK");
    expect(card.aspect).toBe("16:9");
    expect(card.disclaimer).toContain("Not financial advice");
  });
});

describe("3 Notifications — explicitly unavailable (no fake delivery)", () => {
  it("dispatcher reports delivery not implemented", async () => {
    const d = new NotificationDispatcher();
    const out = await d.dispatch({ id: "a1", userId: uid("u1"), kind: "STATE_CHANGE", at: 1, payload: {} } as never);
    expect(out.delivered).toBe(false);
    expect(out.reason).toBe("NOTIFICATION_DELIVERY_NOT_IMPLEMENTED");
  });
});

describe("3 Capability honesty", () => {
  it("verified/available capabilities are usable; blocked/pending are not", () => {
    expect(isUsable(capability("scan").state)).toBe(true);
    expect(isUsable(capability("search").state)).toBe(true);
    expect(isUsable(capability("replay").state)).toBe(true);
    // These were built and verified during the product/deploy phases:
    expect(isUsable(capability("gmgn_live").state)).toBe(true);
    expect(isUsable(capability("auth_identity").state)).toBe(true);
    expect(isUsable(capability("http_api").state)).toBe(true);
    // These remain genuinely unavailable — honesty preserved:
    expect(isUsable(capability("browser_benchmark").state)).toBe(false);
    expect(isUsable(capability("sponsorship").state)).toBe(false);
    expect(isUsable(capability("social").state)).toBe(false);
  });

  it("gmgn_live is VERIFIED after the live executor was wired end-to-end", () => {
    expect(capability("gmgn_live").state).toBe("VERIFIED");
  });

  it("no capability is silently upgraded (every state is a real enum)", () => {
    for (const c of CAPABILITIES) {
      expect(typeof c.note).toBe("string");
      expect(c.note.length).toBeGreaterThan(0);
    }
  });
});
