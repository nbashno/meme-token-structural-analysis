/**
 * WAR Product Layer — payment webhook / settlement.
 *
 * The bridge between a provider's "payment happened" signal (Telegram Stars
 * successful_payment webhook, or a verified TON transfer) and the account's
 * balance. It:
 *   1. validates the raw event shape,
 *   2. checks the amount matches the pack the user intended,
 *   3. credits balance (base + bonus) and upgrades tier if the pack grants it,
 * all idempotently keyed on the provider tx id — replaying a webhook never
 * double-credits.
 *
 * It holds NO intelligence. The actual network verification (calling Telegram's
 * Bot API / reading TON on-chain) lives in a provider adapter injected here; the
 * production adapter is wired at deploy with a real bot token — this service is
 * the deterministic settlement logic around it, fully Node-testable.
 */

import type { UserId, UsdMicros, DomainResult } from "../domain/identity.js";
import { ok, err, usd } from "../domain/identity.js";
import type { BalanceLedger } from "./balance.js";
import type { PricingService, CreditPack } from "../pricing/pricing.js";
import type { PaymentRail } from "./payment.js";

/** A normalized payment event, produced by a rail adapter after it verifies. */
export interface SettledPayment {
  readonly rail: PaymentRail;
  readonly providerTxId: string;
  /** Amount actually paid, in USD micros (adapter converts Stars/TON -> USD). */
  readonly paidMicros: UsdMicros;
  readonly userId: UserId;
  /** Which pack the user was buying (drives bonus + tier). */
  readonly pack: CreditPack;
  readonly at: number;
}

/**
 * A rail adapter turns a raw webhook/transfer into a SettledPayment, or an error
 * if it cannot be verified. Stars and TON each implement this at deploy time.
 */
export interface RailVerifier {
  readonly rail: PaymentRail;
  verify(rawEvent: unknown): DomainResult<SettledPayment>;
}

export interface SettlementResult {
  readonly userId: UserId;
  readonly creditedMicros: UsdMicros;
  readonly newTier: "STANDARD" | "COMMAND";
  readonly reused: boolean; // true if this was an idempotent replay
}

export class PaymentWebhookService {
  private readonly settled = new Set<string>(); // providerTxId seen

  constructor(
    private readonly balances: BalanceLedger,
    private readonly pricing: PricingService,
  ) {}

  /**
   * Settle a verified payment: credit balance (+bonus) and apply tier. Idempotent
   * per providerTxId. The amount must match the pack's price (defends against a
   * spoofed/under-paid event) — a mismatch is refused, never silently accepted.
   */
  settle(payment: SettledPayment): DomainResult<SettlementResult> {
    const pack = this.pricing.packConfig(payment.pack);

    // Amount integrity: paid must be at least the pack price.
    if (payment.paidMicros < pack.priceMicros) {
      return err(
        `underpaid: pack ${payment.pack} needs ${pack.priceMicros}, got ${payment.paidMicros}`,
      );
    }

    const reused = this.settled.has(payment.providerTxId);

    // Credit via the balance ledger (top-up is itself idempotent per tx id).
    const vp = {
      intentId: `pack:${payment.pack}`,
      providerTxId: payment.providerTxId,
      rail: payment.rail,
      status: "VERIFIED" as const,
      verifiedAt: payment.at,
      amountUsd: pack.priceMicros,
    };
    const credited = this.balances.topUp(vp, payment.userId, payment.at, pack.bonusMicros);
    if (!credited.ok) return err(credited.error);

    if (!reused && pack.grantsTier) {
      this.balances.setTier(payment.userId, pack.grantsTier);
    }
    this.settled.add(payment.providerTxId);

    const acct = this.balances.get(payment.userId);
    return ok({
      userId: payment.userId,
      creditedMicros: reused ? usd(0) : (pack.priceMicros + pack.bonusMicros) as UsdMicros,
      newTier: acct?.tier ?? "STANDARD",
      reused,
    });
  }

  /**
   * Full path from a raw webhook: verify via the rail adapter, then settle.
   * This is what an HTTP webhook handler calls.
   */
  handleWebhook(verifier: RailVerifier, rawEvent: unknown): DomainResult<SettlementResult> {
    const verified = verifier.verify(rawEvent);
    if (!verified.ok) return err(`verification failed: ${verified.error}`);
    return this.settle(verified.value);
  }
}
