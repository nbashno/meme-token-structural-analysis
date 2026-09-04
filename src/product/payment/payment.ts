/**
 * WAR Product Layer - Phase 1 - Payment abstraction.
 *
 * Business logic is NOT bound to any payment system. Two rails are supported via
 * adapters: Telegram Stars and TON. The mandatory pipeline is:
 *
 *   Payment Intent -> Provider -> Verified Payment -> Entitlement -> Capability
 *
 * A payment NEVER directly grants a capability or UI access. Verification is
 * server-side and IDEMPOTENT: the same provider transaction, received any number
 * of times, yields exactly one verified payment (and downstream, one entitlement).
 *
 * Phase 1 defines the abstraction + a deterministic in-memory provider for tests.
 * Real Telegram/TON wire behaviour is a later phase (spec: Phase 6).
 */

import type { UsdMicros, UserId, DomainResult } from "../domain/identity.js";
import { ok, err } from "../domain/identity.js";
import type { EntitlementType } from "../pricing/pricing.js";

export type PaymentRail = "TELEGRAM_STARS" | "TON";

export type PaymentStatus =
  | "CREATED"
  | "VERIFIED"
  | "FAILED"
  | "REFUNDED";

/** An intent to pay for a specific capability. Amount is USD-canonical. */
export interface PaymentIntent {
  readonly id: string; // product-side immutable id
  readonly userId: UserId;
  readonly rail: PaymentRail;
  readonly entitlementType: EntitlementType;
  readonly amountUsd: UsdMicros;
  readonly pricingVersion: string;
  readonly createdAt: number; // UnixMillis
}

/** A payment the provider has confirmed. providerTxId is the idempotency key. */
export interface VerifiedPayment {
  readonly intentId: string;
  readonly providerTxId: string; // immutable, provider-unique
  readonly rail: PaymentRail;
  readonly status: "VERIFIED";
  readonly verifiedAt: number; // UnixMillis
  readonly amountUsd: UsdMicros;
}

/** The provider adapter contract. Stars/TON each implement this. */
export interface PaymentProvider {
  readonly rail: PaymentRail;
  createPayment(intent: PaymentIntent): DomainResult<{ providerRef: string }>;
  /** Verify by provider tx id. MUST be safe to call repeatedly (idempotent). */
  verifyPayment(providerTxId: string): DomainResult<VerifiedPayment>;
  getPaymentStatus(providerTxId: string): DomainResult<PaymentStatus>;
  refundPayment(providerTxId: string): DomainResult<{ refundedAt: number }>;
}

/**
 * Deterministic in-memory provider used to drive Phase 1 tests. It records
 * intents and lets a test "confirm" a tx; verification is idempotent by tx id.
 * No network, no clock of its own - the caller injects time via confirm().
 */
export class InMemoryPaymentProvider implements PaymentProvider {
  readonly rail: PaymentRail;
  private readonly intents = new Map<string, PaymentIntent>();
  private readonly confirmed = new Map<string, VerifiedPayment>();
  private readonly refunded = new Set<string>();

  constructor(rail: PaymentRail) {
    this.rail = rail;
  }

  createPayment(intent: PaymentIntent): DomainResult<{ providerRef: string }> {
    if (intent.rail !== this.rail) {
      return err(`intent rail ${intent.rail} != provider rail ${this.rail}`);
    }
    this.intents.set(intent.id, intent);
    return ok({ providerRef: `ref:${intent.id}` });
  }

  /** Test hook: simulate the provider confirming a payment at a given time. */
  confirm(intentId: string, providerTxId: string, atMs: number): DomainResult<VerifiedPayment> {
    const intent = this.intents.get(intentId);
    if (!intent) return err(`unknown intent ${intentId}`);
    const existing = this.confirmed.get(providerTxId);
    if (existing) return ok(existing); // idempotent
    const vp: VerifiedPayment = {
      intentId,
      providerTxId,
      rail: this.rail,
      status: "VERIFIED",
      verifiedAt: atMs,
      amountUsd: intent.amountUsd,
    };
    this.confirmed.set(providerTxId, vp);
    return ok(vp);
  }

  verifyPayment(providerTxId: string): DomainResult<VerifiedPayment> {
    const vp = this.confirmed.get(providerTxId);
    if (!vp) return err(`payment ${providerTxId} not confirmed`);
    if (this.refunded.has(providerTxId)) return err(`payment ${providerTxId} refunded`);
    return ok(vp);
  }

  getPaymentStatus(providerTxId: string): DomainResult<PaymentStatus> {
    if (this.refunded.has(providerTxId)) return ok("REFUNDED");
    if (this.confirmed.has(providerTxId)) return ok("VERIFIED");
    return ok("CREATED");
  }

  refundPayment(providerTxId: string): DomainResult<{ refundedAt: number }> {
    if (!this.confirmed.has(providerTxId)) return err(`cannot refund unknown ${providerTxId}`);
    this.refunded.add(providerTxId);
    return ok({ refundedAt: 0 });
  }
}

/** Adapter names, kept explicit so the domain never assumes a single rail. */
export class TelegramStarsProvider extends InMemoryPaymentProvider {
  constructor() {
    super("TELEGRAM_STARS");
  }
}
export class TonProvider extends InMemoryPaymentProvider {
  constructor() {
    super("TON");
  }
}
