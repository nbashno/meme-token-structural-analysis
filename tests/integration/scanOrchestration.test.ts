import { describe, it, expect, beforeEach } from "vitest";

import { InMemoryUnitOfWork } from "../../src/product/persistence/memory/inMemory.js";
import { EntitlementLedger } from "../../src/product/payment/entitlement.js";
import { ScanService } from "../../src/product/scan/orchestration/scanService.js";
import type {
  GmgnAcquisitionPort,
  WarEvaluationPort,
  NormalizedObservations,
} from "../../src/product/scan/ports/ports.js";
import type { UserId, TokenId, Clock } from "../../src/product/domain/identity.js";
import { ok, err } from "../../src/product/domain/identity.js";
import { MODEL_VERSIONS, ENGINE_VERSION } from "../../src/config/versions.js";
import { PRICING_V1 } from "../../src/product/pricing/pricing.js";
import { makeEntry, makeBattlefield } from "../unit/productFixtures.js";
import type { BattlefieldState } from "../../src/core/battlefield/types.js";

const uid = (s: string) => s as UserId;
const tok: TokenId = { chain: "sol", address: "TokenAAA" as TokenId["address"] };

function clockAt(ms: number): Clock {
  return { now: () => ms };
}

const emptyObs = (): NormalizedObservations => ({
  chain: "sol", address: tok.address, market: [], analytics: [], flow: [],
  observedFromMs: 0, observedToMs: 1000,
});

/** Acquisition that succeeds. */
const goodAcq: GmgnAcquisitionPort = {
  async acquire() {
    return ok(emptyObs());
  },
};
/** Acquisition that fails (simulated GMGN outage). */
const failingAcq: GmgnAcquisitionPort = {
  async acquire() {
    return err("gmgn timeout");
  },
};

/** Evaluation returning a battlefield that contains our token. */
function goodEval(battlefield: BattlefieldState): WarEvaluationPort {
  return { async evaluate() { return ok(battlefield); } };
}
/** Evaluation that fails (simulated WAR error). */
const failingEval: WarEvaluationPort = {
  async evaluate() { return err("core exploded"); },
};
/** Evaluation returning a battlefield WITHOUT our token (no meaningful result). */
const emptyEval: WarEvaluationPort = {
  async evaluate() { return ok(makeBattlefield([])); },
};

interface Harness {
  uow: InMemoryUnitOfWork;
  ledger: EntitlementLedger;
  service: (acq: GmgnAcquisitionPort, evalPort: WarEvaluationPort) => ScanService;
  seedEntitlement: (id: string) => Promise<void>;
}

async function makeHarness(): Promise<Harness> {
  const uow = new InMemoryUnitOfWork();
  const ledger = new EntitlementLedger();
  await uow.repos.pricing.record(PRICING_V1);
  await uow.repos.users.upsert({ userId: uid("u1"), provider: "TELEGRAM", providerUserId: "tg:1", createdAt: 0 });

  const seedEntitlement = async (id: string) => {
    const vp = { intentId: "i", providerTxId: id.replace("ent:", ""), rail: "TON" as const, status: "VERIFIED" as const, verifiedAt: 100, amountUsd: 100000 as never };
    ledger.issueFrom(vp, uid("u1"), "TOKEN_SCAN", null);
    await uow.repos.payments.createIntent({
      providerTxId: id.replace("ent:", ""), intentId: `i-${id}`, userId: uid("u1"), rail: "TON",
      entitlementType: "TOKEN_SCAN", amountUsdMicros: 100000, pricingVersion: PRICING_V1.version,
      status: "VERIFIED", createdAt: 0, verifiedAt: 100, refundedAt: null,
    });
    await uow.repos.entitlements.issue({
      id, userId: uid("u1"), type: "TOKEN_SCAN", providerTxId: id.replace("ent:", ""),
      status: "ISSUED", grantsDurationMs: null, issuedAt: 100,
    });
  };

  const service = (acq: GmgnAcquisitionPort, evalPort: WarEvaluationPort) =>
    new ScanService({
      uow, acquisition: acq, evaluation: evalPort, clock: clockAt(1000),
      entitlements: ledger, engineVersion: ENGINE_VERSION, modelVersions: MODEL_VERSIONS,
    });

  return { uow, ledger, service, seedEntitlement };
}

describe("Phase 3 — Scan Orchestration", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });

  it("happy path: pay -> acquire -> WAR -> report -> persist -> consume", async () => {
    await h.seedEntitlement("ent:tx1");
    const bf = makeBattlefield([makeEntry({ address: "TokenAAA" })]);
    const svc = h.service(goodAcq, goodEval(bf));

    const r = await svc.execute({ requestId: "req1", userId: uid("u1"), token: tok, entitlementId: "ent:tx1" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.reused).toBe(false);
    // snapshot persisted and consumable
    expect(await h.uow.repos.intelligence.getSnapshot(r.value.snapshotId)).not.toBeNull();
    // entitlement consumed
    const ent = await h.uow.repos.entitlements.get("ent:tx1");
    expect(ent?.status).toBe("CONSUMED");
    expect(await h.uow.repos.usage.get("ent:tx1")).not.toBeNull();
  });

  it("result carries versions, evidence, whyNow, provenance (condition 7)", async () => {
    await h.seedEntitlement("ent:tx7");
    const entry = makeEntry({
      address: "TokenAAA",
      supporting: [{ factor: "flow_accel", magnitude: 12, weight: 0.5 }],
      events: [],
      signals: [],
    });
    const bf = makeBattlefield([entry]);
    const r = await h.service(goodAcq, goodEval(bf)).execute({
      requestId: "req7", userId: uid("u1"), token: tok, entitlementId: "ent:tx7",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rep = r.value.report;
    expect(rep.modelVersions.engineVersion).toBe(ENGINE_VERSION);
    expect(rep.generatedAt).toBeTypeOf("number");
    expect(rep.evidence.length).toBeGreaterThan(0);
    expect(Array.isArray(rep.whyNow)).toBe(true);
  });

  it("GMGN failure => FAILED, entitlement NOT consumed (condition 4)", async () => {
    await h.seedEntitlement("ent:tx2");
    const r = await h.service(failingAcq, emptyEval).execute({
      requestId: "req2", userId: uid("u1"), token: tok, entitlementId: "ent:tx2",
    });
    expect(r.ok).toBe(false);
    const ent = await h.uow.repos.entitlements.get("ent:tx2");
    expect(ent?.status).toBe("ISSUED"); // released, not consumed
    expect(await h.uow.repos.usage.get("ent:tx2")).toBeNull();
  });

  it("WAR failure => FAILED, entitlement NOT consumed (condition 4)", async () => {
    await h.seedEntitlement("ent:tx3");
    const r = await h.service(goodAcq, failingEval).execute({
      requestId: "req3", userId: uid("u1"), token: tok, entitlementId: "ent:tx3",
    });
    expect(r.ok).toBe(false);
    expect((await h.uow.repos.entitlements.get("ent:tx3"))?.status).toBe("ISSUED");
  });

  it("no meaningful result => FAILED, not consumed (condition 3)", async () => {
    await h.seedEntitlement("ent:tx4");
    const r = await h.service(goodAcq, emptyEval).execute({
      requestId: "req4", userId: uid("u1"), token: tok, entitlementId: "ent:tx4",
    });
    expect(r.ok).toBe(false);
    expect((await h.uow.repos.entitlements.get("ent:tx4"))?.status).toBe("ISSUED");
  });

  it("retry after success is idempotent: same snapshot, reused=true (condition 5)", async () => {
    await h.seedEntitlement("ent:tx5");
    const bf = makeBattlefield([makeEntry({ address: "TokenAAA" })]);
    const svc = h.service(goodAcq, goodEval(bf));
    const first = await svc.execute({ requestId: "req5", userId: uid("u1"), token: tok, entitlementId: "ent:tx5" });
    const second = await svc.execute({ requestId: "req5", userId: uid("u1"), token: tok, entitlementId: "ent:tx5" });
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.value.reused).toBe(true);
      expect(second.value.snapshotId).toBe(first.value.snapshotId);
    }
  });

  it("double-spend: a consumed entitlement cannot fund a second scan (condition 6)", async () => {
    await h.seedEntitlement("ent:tx6");
    const bf = makeBattlefield([makeEntry({ address: "TokenAAA" })]);
    const svc = h.service(goodAcq, goodEval(bf));
    // First scan consumes the entitlement.
    const first = await svc.execute({ requestId: "req6a", userId: uid("u1"), token: tok, entitlementId: "ent:tx6" });
    expect(first.ok).toBe(true);
    // A DIFFERENT request trying to reuse the same entitlement must fail.
    const second = await svc.execute({ requestId: "req6b", userId: uid("u1"), token: tok, entitlementId: "ent:tx6" });
    expect(second.ok).toBe(false);
  });

  it("a failed scan can be retried cleanly and then succeed (condition 4/5)", async () => {
    await h.seedEntitlement("ent:tx8");
    // First attempt: GMGN down.
    const fail = await h.service(failingAcq, emptyEval).execute({
      requestId: "req8", userId: uid("u1"), token: tok, entitlementId: "ent:tx8",
    });
    expect(fail.ok).toBe(false);
    // Retry same request with GMGN back up: should succeed and consume now.
    const bf = makeBattlefield([makeEntry({ address: "TokenAAA" })]);
    const retry = await h.service(goodAcq, goodEval(bf)).execute({
      requestId: "req8", userId: uid("u1"), token: tok, entitlementId: "ent:tx8",
    });
    expect(retry.ok).toBe(true);
    expect((await h.uow.repos.entitlements.get("ent:tx8"))?.status).toBe("CONSUMED");
  });
});
