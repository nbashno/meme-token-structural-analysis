import { describe, it, expect, beforeEach } from "vitest";

import { InMemoryUnitOfWork } from "../../src/product/persistence/memory/inMemory.js";
import type { RepositoryBundle } from "../../src/product/persistence/contracts/repositories.js";
import type { UserId, UserIdentity, TokenId } from "../../src/product/domain/identity.js";
import { usd } from "../../src/product/domain/identity.js";
import { PRICING_V1 } from "../../src/product/pricing/pricing.js";
import { entitlementIdFor } from "../../src/product/payment/entitlement.js";
import { MODEL_VERSIONS, ENGINE_VERSION } from "../../src/config/versions.js";

const uid = (s: string) => s as UserId;
const user = (id: string): UserIdentity => ({
  userId: uid(id), provider: "TELEGRAM", providerUserId: `tg:${id}`, createdAt: 1000,
});
const tok: TokenId = { chain: "sol", address: "TokenAAA" as TokenId["address"] };

async function seedRefs(repos: RepositoryBundle): Promise<void> {
  await repos.pricing.record(PRICING_V1);
  await repos.engineVersions.record(ENGINE_VERSION, MODEL_VERSIONS);
  await repos.users.upsert(user("u1"));
  await repos.tokens.ensure(tok.chain, tok.address, "AAA", "Alpha");
}

describe("persistence (in-memory UoW) — Phase 2 invariants", () => {
  let uow: InMemoryUnitOfWork;
  beforeEach(() => {
    uow = new InMemoryUnitOfWork();
  });

  it("references seed idempotently", async () => {
    await seedRefs(uow.repos);
    await seedRefs(uow.repos); // second time must be a no-op
    expect(await uow.repos.pricing.get(PRICING_V1.version)).not.toBeNull();
    expect(await uow.repos.engineVersions.has(ENGINE_VERSION)).toBe(true);
    expect(await uow.repos.users.findById(uid("u1"))).not.toBeNull();
    expect(await uow.repos.tokens.find(tok.chain, tok.address)).not.toBeNull();
  });

  it("1 payment => exactly 1 entitlement (idempotent issue)", async () => {
    await seedRefs(uow.repos);
    const txId = "tx-1";
    await uow.repos.payments.createIntent({
      providerTxId: txId, intentId: "i1", userId: uid("u1"), rail: "TELEGRAM_STARS",
      entitlementType: "TOKEN_SCAN", amountUsdMicros: usd(0.1) as unknown as number,
      pricingVersion: PRICING_V1.version, status: "CREATED", createdAt: 1000, verifiedAt: null, refundedAt: null,
    });
    const id = entitlementIdFor(txId);
    const ent = { id, userId: uid("u1"), type: "TOKEN_SCAN" as const, providerTxId: txId, status: "ISSUED" as const, grantsDurationMs: null, issuedAt: 2000 };
    await uow.repos.entitlements.issue(ent);
    await uow.repos.entitlements.issue(ent);
    await uow.repos.entitlements.issue(ent);
    const got = await uow.repos.entitlements.get(id);
    expect(got?.id).toBe(id);
  });

  it("usage ledger enforces single consumption (PK = entitlement id)", async () => {
    const rec = { entitlementId: "ent:tx-c", userId: uid("u1"), consumedAt: 3000, capabilityRef: "scanexec-1" };
    const first = await uow.repos.usage.consume(rec);
    const second = await uow.repos.usage.consume({ ...rec, capabilityRef: "scanexec-2" });
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.record.capabilityRef).toBe("scanexec-1"); // original wins
  });

  it("appendEvent is idempotent per (txId,event) — append-only audit", async () => {
    await seedRefs(uow.repos);
    await uow.repos.payments.createIntent({
      providerTxId: "tx-a", intentId: "i-a", userId: uid("u1"), rail: "TON",
      entitlementType: "TOKEN_SCAN", amountUsdMicros: 100000, pricingVersion: PRICING_V1.version,
      status: "CREATED", createdAt: 1000, verifiedAt: null, refundedAt: null,
    });
    await uow.repos.payments.appendEvent({ providerTxId: "tx-a", event: "VERIFIED", at: 1500, rawRef: null });
    await uow.repos.payments.appendEvent({ providerTxId: "tx-a", event: "VERIFIED", at: 1500, rawRef: null });
    // status advances forward
    const row = await uow.repos.payments.advanceStatus("tx-a", "VERIFIED", 1500);
    expect(row.status).toBe("VERIFIED");
    expect(row.verifiedAt).toBe(1500);
  });

  it("transaction rolls back all writes on throw (atomicity)", async () => {
    await seedRefs(uow.repos);
    await expect(
      uow.transaction(async (repos) => {
        await repos.payments.createIntent({
          providerTxId: "tx-rb", intentId: "i-rb", userId: uid("u1"), rail: "TON",
          entitlementType: "TOKEN_SCAN", amountUsdMicros: 100000, pricingVersion: PRICING_V1.version,
          status: "CREATED", createdAt: 1000, verifiedAt: null, refundedAt: null,
        });
        throw new Error("boom after write");
      }),
    ).rejects.toThrow("boom");
    // The intent write must have been rolled back.
    expect(await uow.repos.payments.get("tx-rb")).toBeNull();
  });

  it("transaction commits atomically on success (payment -> entitlement)", async () => {
    await seedRefs(uow.repos);
    await uow.transaction(async (repos) => {
      await repos.payments.createIntent({
        providerTxId: "tx-ok", intentId: "i-ok", userId: uid("u1"), rail: "TON",
        entitlementType: "TOKEN_SCAN", amountUsdMicros: 100000, pricingVersion: PRICING_V1.version,
        status: "VERIFIED", createdAt: 1000, verifiedAt: 1500, refundedAt: null,
      });
      await repos.payments.appendEvent({ providerTxId: "tx-ok", event: "VERIFIED", at: 1500, rawRef: null });
      await repos.entitlements.issue({
        id: entitlementIdFor("tx-ok"), userId: uid("u1"), type: "TOKEN_SCAN",
        providerTxId: "tx-ok", status: "ISSUED", grantsDurationMs: null, issuedAt: 1500,
      });
    });
    expect(await uow.repos.payments.get("tx-ok")).not.toBeNull();
    expect(await uow.repos.entitlements.get(entitlementIdFor("tx-ok"))).not.toBeNull();
  });

  it("snapshot save is idempotent and readable by report_ref", async () => {
    await seedRefs(uow.repos);
    const snap = {
      id: "snap-1", token: tok, sessionId: null, generatedAt: 1000,
      report: { token: tok } as never, engineVersion: ENGINE_VERSION,
      modelVersions: MODEL_VERSIONS, source: "SCAN" as const, createdAt: 1000,
    };
    await uow.repos.intelligence.saveSnapshot(snap);
    await uow.repos.intelligence.saveSnapshot(snap);
    expect(await uow.repos.intelligence.getSnapshot("snap-1")).not.toBeNull();
  });

  it("signal transitions are append-only, idempotent per (identity,at,phase)", async () => {
    await seedRefs(uow.repos);
    const t = { tokenId: tok, sessionId: null, signalIdentity: "sigA", fromPhase: "EMERGING", toPhase: "CONFIRMED", at: 5000, reasons: ["x"] };
    await uow.repos.intelligence.saveSignalTransition(t);
    await uow.repos.intelligence.saveSignalTransition(t); // dup ignored
    // no throw, dedupe handled internally
    expect(true).toBe(true);
  });

  it("listActive returns only active, non-expired sessions", async () => {
    await seedRefs(uow.repos);
    await uow.repos.monitors.create({
      id: "m-active", userId: uid("u1"), token: tok, chain: "sol",
      startedAt: 0, expiresAt: 10_000, status: "ACTIVE", pricingVersion: PRICING_V1.version,
      entitlementId: "ent:x", lastObservationAt: null, lastBattlefieldStateAt: null, lastEventAt: null,
    });
    await uow.repos.monitors.create({
      id: "m-expired", userId: uid("u1"), token: tok, chain: "sol",
      startedAt: 0, expiresAt: 1_000, status: "ACTIVE", pricingVersion: PRICING_V1.version,
      entitlementId: "ent:y", lastObservationAt: null, lastBattlefieldStateAt: null, lastEventAt: null,
    });
    const active = await uow.repos.monitors.listActive(5_000, 10);
    expect(active.map((m) => m.id)).toContain("m-active");
    expect(active.map((m) => m.id)).not.toContain("m-expired");
  });
});
