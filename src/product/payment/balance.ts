/**
 * WAR Product Layer — Balance ledger (prepaid credit) + free-scan grant + tier.
 *
 * A user's prepaid USD balance, topped up by verified payments and debited
 * atomically per capability run. Mirrors EntitlementLedger discipline:
 *   - A debit is idempotent per (userId, opId): the same opId never debits twice.
 *   - A failed capability run must be refunded (release), never silently kept.
 *   - Insufficient balance refuses — it never goes negative, never "estimates".
 *
 * The free quota (3 scans for new users) is modeled as a small non-monetary
 * counter granted once at registration; scans consume the free counter first,
 * then fall back to paid balance. The COMMAND tier is a flag read when enforcing
 * limits — it holds NO intelligence and changes no scoring.
 */

import type { UserId, UsdMicros, DomainResult } from "../domain/identity.js";
import { ok, err, usd } from "../domain/identity.js";
import type { VerifiedPayment } from "../payment/payment.js";

export type AccountTier = "STANDARD" | "COMMAND";

/** Free scans granted once to a new account. */
export const FREE_SCAN_GRANT = 3;

export interface AccountBalance {
  readonly userId: UserId;
  /** Prepaid monetary balance in USD micros (never negative). */
  readonly balanceMicros: UsdMicros;
  /** Remaining one-time free scans. */
  readonly freeScans: number;
  readonly tier: AccountTier;
  readonly createdAt: number;
}

/** One immutable ledger movement, for auditability. */
export interface BalanceMovement {
  readonly userId: UserId;
  readonly opId: string; // unique per debit/credit; idempotency key
  readonly kind: "TOPUP" | "DEBIT" | "REFUND" | "FREE_GRANT" | "FREE_DEBIT";
  readonly amountMicros: UsdMicros;
  readonly at: number;
  readonly note: string;
}

/** How a scan/monitor charge was satisfied. */
export type ChargeSource = "FREE" | "BALANCE";

export interface ChargeResult {
  readonly source: ChargeSource;
  readonly opId: string;
}

export class BalanceLedger {
  private readonly accounts = new Map<UserId, AccountBalance>();
  private readonly movements = new Map<string, BalanceMovement>(); // key = opId
  private readonly refunded = new Set<string>();

  /** Open an account once, granting the free-scan quota. Idempotent. */
  register(userId: UserId, atMs: number, tier: AccountTier = "STANDARD"): AccountBalance {
    const existing = this.accounts.get(userId);
    if (existing) return existing;
    const acct: AccountBalance = {
      userId,
      balanceMicros: usd(0),
      freeScans: FREE_SCAN_GRANT,
      tier,
      createdAt: atMs,
    };
    this.accounts.set(userId, acct);
    return acct;
  }

  get(userId: UserId): AccountBalance | undefined {
    return this.accounts.get(userId);
  }

  private require(userId: UserId): AccountBalance {
    return this.accounts.get(userId) ?? this.register(userId, 0);
  }

  /** Credit balance from a verified payment. Idempotent per providerTxId. */
  topUp(payment: VerifiedPayment, userId: UserId, atMs: number, bonusMicros: UsdMicros = usd(0)): DomainResult<AccountBalance> {
    const opId = `topup:${payment.providerTxId}`;
    if (this.movements.has(opId)) return ok(this.require(userId)); // idempotent
    const acct = this.require(userId);
    const credited = (acct.balanceMicros + payment.amountUsd + bonusMicros) as UsdMicros;
    const next: AccountBalance = { ...acct, balanceMicros: credited };
    this.accounts.set(userId, next);
    this.movements.set(opId, {
      userId, opId, kind: "TOPUP", amountMicros: (payment.amountUsd + bonusMicros) as UsdMicros,
      at: atMs, note: `topup via ${payment.rail}`,
    });
    return ok(next);
  }

  /** Set tier (e.g. after a COMMAND purchase). */
  setTier(userId: UserId, tier: AccountTier): DomainResult<AccountBalance> {
    const acct = this.require(userId);
    const next = { ...acct, tier };
    this.accounts.set(userId, next);
    return ok(next);
  }

  /**
   * Charge for one capability run. Free scans first (if allowed), then paid
   * balance. Idempotent per opId: replaying the same opId returns the same
   * result without double-charging. Refuses cleanly if funds are insufficient.
   */
  charge(
    userId: UserId,
    opId: string,
    priceMicros: UsdMicros,
    atMs: number,
    opts: { readonly allowFree: boolean } = { allowFree: true },
  ): DomainResult<ChargeResult> {
    const prior = this.movements.get(opId);
    if (prior) {
      // Idempotent replay: report how it was originally satisfied.
      return ok({ source: prior.kind === "FREE_DEBIT" ? "FREE" : "BALANCE", opId });
    }
    const acct = this.require(userId);

    if (opts.allowFree && acct.freeScans > 0) {
      this.accounts.set(userId, { ...acct, freeScans: acct.freeScans - 1 });
      this.movements.set(opId, { userId, opId, kind: "FREE_DEBIT", amountMicros: usd(0), at: atMs, note: "free scan" });
      return ok({ source: "FREE", opId });
    }

    if (acct.balanceMicros < priceMicros) {
      return err(`insufficient balance: need ${priceMicros}, have ${acct.balanceMicros}`);
    }
    this.accounts.set(userId, { ...acct, balanceMicros: (acct.balanceMicros - priceMicros) as UsdMicros });
    this.movements.set(opId, { userId, opId, kind: "DEBIT", amountMicros: priceMicros, at: atMs, note: "capability charge" });
    return ok({ source: "BALANCE", opId });
  }

  /**
   * Refund a prior charge when the capability run failed. Idempotent; only a
   * real prior DEBIT/FREE_DEBIT can be refunded, and only once.
   */
  refund(userId: UserId, opId: string, atMs: number): DomainResult<AccountBalance> {
    const mv = this.movements.get(opId);
    if (!mv) return err(`no charge ${opId} to refund`);
    if (mv.userId !== userId) return err(`charge ${opId} not owned by user`);
    if (this.refunded.has(opId)) return ok(this.require(userId)); // idempotent
    const acct = this.require(userId);

    if (mv.kind === "FREE_DEBIT") {
      this.accounts.set(userId, { ...acct, freeScans: acct.freeScans + 1 });
    } else if (mv.kind === "DEBIT") {
      this.accounts.set(userId, { ...acct, balanceMicros: (acct.balanceMicros + mv.amountMicros) as UsdMicros });
    } else {
      return err(`movement ${opId} is not a refundable charge`);
    }
    this.refunded.add(opId);
    this.movements.set(`refund:${opId}`, { userId, opId: `refund:${opId}`, kind: "REFUND", amountMicros: mv.amountMicros, at: atMs, note: `refund of ${opId}` });
    return ok(this.require(userId));
  }

  /** Audit trail for an account. */
  movementsFor(userId: UserId): readonly BalanceMovement[] {
    return [...this.movements.values()].filter((m) => m.userId === userId).sort((a, b) => a.at - b.at);
  }
}
