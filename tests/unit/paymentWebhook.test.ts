import { describe, it, expect } from "vitest";
import { PaymentWebhookService } from "../../src/product/payment/paymentWebhook.js";
import { TelegramStarsVerifier, TonVerifier } from "../../src/product/payment/railVerifiers.js";
import { BalanceLedger } from "../../src/product/payment/balance.js";
import { PricingService, PRICING_V2 } from "../../src/product/pricing/pricing.js";
import { usd } from "../../src/product/domain/identity.js";
import type { UserId } from "../../src/product/domain/identity.js";

const U = "u1" as UserId;
const pricing = new PricingService(PRICING_V2);
const yes = () => true;
const no = () => false;

describe("payment settlement — credit + tier + idempotency", () => {
  it("settles a COMMAND pack: +$1200 and tier upgrade", () => {
    const bal = new BalanceLedger(); bal.register(U, 0);
    const web = new PaymentWebhookService(bal, pricing);
    const r = web.settle({ rail: "TELEGRAM_STARS", providerTxId: "tx1", paidMicros: usd(1000), userId: U, pack: "PACK_COMMAND", at: 1 });
    expect(r.ok).toBe(true);
    expect(bal.get(U)!.balanceMicros).toBe(usd(1200)); // 1000 + 200 bonus
    expect(bal.get(U)!.tier).toBe("COMMAND");
  });

  it("is idempotent — replaying the same tx never double-credits", () => {
    const bal = new BalanceLedger(); bal.register(U, 0);
    const web = new PaymentWebhookService(bal, pricing);
    const p = { rail: "TON" as const, providerTxId: "txDup", paidMicros: usd(20), userId: U, pack: "PACK_MEDIUM" as const, at: 1 };
    web.settle(p);
    const again = web.settle(p);
    expect(again.ok && again.value.reused).toBe(true);
    expect(bal.get(U)!.balanceMicros).toBe(usd(21)); // 20 + 1 bonus, once
  });

  it("refuses an underpaid event (amount integrity)", () => {
    const bal = new BalanceLedger(); bal.register(U, 0);
    const web = new PaymentWebhookService(bal, pricing);
    const r = web.settle({ rail: "TON", providerTxId: "txLow", paidMicros: usd(0.5), userId: U, pack: "PACK_SMALL", at: 1 });
    expect(r.ok).toBe(false);
    expect(bal.get(U)!.balanceMicros).toBe(0); // nothing credited
  });
});

describe("Telegram Stars verifier", () => {
  it("accepts a well-formed, authentic charge", () => {
    const v = new TelegramStarsVerifier(yes);
    const r = v.verify({
      telegram_payment_charge_id: "chg_1",
      invoice_payload: { pack: "PACK_SMALL", userId: "u1" },
      usdMicros: usd(5), at: 10,
    });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.value.pack).toBe("PACK_SMALL"); expect(r.value.userId).toBe("u1"); }
  });

  it("rejects when Telegram does not confirm the charge", () => {
    const v = new TelegramStarsVerifier(no);
    const r = v.verify({ telegram_payment_charge_id: "chg_1", invoice_payload: { pack: "PACK_SMALL", userId: "u1" }, usdMicros: usd(5) });
    expect(r.ok).toBe(false);
  });

  it("rejects malformed payloads without throwing", () => {
    const v = new TelegramStarsVerifier(yes);
    expect(v.verify(null).ok).toBe(false);
    expect(v.verify({}).ok).toBe(false);
    expect(v.verify({ telegram_payment_charge_id: "x", invoice_payload: { pack: "BAD", userId: "u1" }, usdMicros: usd(5) }).ok).toBe(false);
    expect(v.verify({ telegram_payment_charge_id: "x", invoice_payload: { pack: "PACK_SMALL" }, usdMicros: usd(5) }).ok).toBe(false);
  });
});

describe("TON verifier", () => {
  it("accepts a well-formed, on-chain-confirmed transfer", () => {
    const v = new TonVerifier(yes);
    const r = v.verify({ txHash: "0xabc", pack: "PACK_LARGE", userId: "u1", usdMicros: usd(50), at: 5 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.rail).toBe("TON");
  });

  it("rejects when the transfer is not found on-chain", () => {
    const v = new TonVerifier(no);
    expect(v.verify({ txHash: "0xabc", pack: "PACK_LARGE", userId: "u1", usdMicros: usd(50) }).ok).toBe(false);
  });
});

describe("full webhook path — verify then settle", () => {
  it("credits balance from an authentic Stars webhook", () => {
    const bal = new BalanceLedger(); bal.register(U, 0);
    const web = new PaymentWebhookService(bal, pricing);
    const verifier = new TelegramStarsVerifier(yes);
    const r = web.handleWebhook(verifier, {
      telegram_payment_charge_id: "chg_9",
      invoice_payload: { pack: "PACK_COMMAND", userId: "u1" },
      usdMicros: usd(1000), at: 1,
    });
    expect(r.ok).toBe(true);
    expect(bal.get(U)!.balanceMicros).toBe(usd(1200));
    expect(bal.get(U)!.tier).toBe("COMMAND");
  });

  it("rejects an inauthentic webhook end to end", () => {
    const bal = new BalanceLedger(); bal.register(U, 0);
    const web = new PaymentWebhookService(bal, pricing);
    const r = web.handleWebhook(new TonVerifier(no), { txHash: "x", pack: "PACK_SMALL", userId: "u1", usdMicros: usd(5) });
    expect(r.ok).toBe(false);
    expect(bal.get(U)!.balanceMicros).toBe(0);
  });
});
