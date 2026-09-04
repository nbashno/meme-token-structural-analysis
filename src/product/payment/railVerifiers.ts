/**
 * WAR Product Layer — rail verifiers (Telegram Stars + TON).
 *
 * Each turns a raw provider event into a SettledPayment after verifying it.
 * The DETERMINISTIC part (shape validation, field extraction, amount mapping)
 * lives here and is fully tested. The NETWORK part (confirming the event is
 * genuine with Telegram's Bot API / TON chain) is a single injected check —
 * at deploy it calls the real API with a bot token; in tests it is a stub.
 * Nothing is faked: without a real verifier the check fails closed.
 */

import type { UserId, UsdMicros, DomainResult } from "../domain/identity.js";
import { ok, err, usd } from "../domain/identity.js";
import type { CreditPack } from "../pricing/pricing.js";
import type { RailVerifier, SettledPayment } from "./paymentWebhook.js";

/** Injected authenticity check: is this provider tx genuine? */
export type AuthenticityCheck = (providerTxId: string) => boolean;

/** Map a pack id from an arbitrary payload string, safely. */
function asPack(v: unknown): CreditPack | null {
  return v === "PACK_SMALL" || v === "PACK_MEDIUM" || v === "PACK_LARGE" || v === "PACK_COMMAND" ? v : null;
}

/**
 * Telegram Stars. The successful_payment webhook carries invoice_payload (we put
 * the pack id + userId there when creating the invoice) and total_amount in the
 * smallest currency unit. For XTR (Stars), the adapter converts Stars->USD via a
 * pinned rate; here we accept a pre-converted `usdMicros` the adapter attached.
 */
export class TelegramStarsVerifier implements RailVerifier {
  readonly rail = "TELEGRAM_STARS" as const;
  constructor(private readonly isAuthentic: AuthenticityCheck) {}

  verify(rawEvent: unknown): DomainResult<SettledPayment> {
    if (typeof rawEvent !== "object" || rawEvent === null) return err("event not an object");
    const e = rawEvent as Record<string, unknown>;
    const txId = e["telegram_payment_charge_id"];
    const payload = e["invoice_payload"];
    const usdMicros = e["usdMicros"];
    const at = e["at"];

    if (typeof txId !== "string" || txId.length === 0) return err("missing charge id");
    if (typeof payload !== "object" || payload === null) return err("missing invoice payload");
    const p = payload as Record<string, unknown>;
    const pack = asPack(p["pack"]);
    const userId = p["userId"];
    if (!pack) return err("invalid or missing pack in payload");
    if (typeof userId !== "string" || userId.length === 0) return err("missing userId in payload");
    if (typeof usdMicros !== "number" || !Number.isFinite(usdMicros) || usdMicros <= 0) return err("invalid amount");

    if (!this.isAuthentic(txId)) return err("Telegram did not confirm this charge");

    return ok({
      rail: this.rail,
      providerTxId: txId,
      paidMicros: usdMicros as UsdMicros,
      userId: userId as UserId,
      pack,
      at: typeof at === "number" ? at : Date.now(),
    });
  }
}

/**
 * TON. A verified transfer carries the tx hash, the comment/payload (pack +
 * userId), and the amount in nanotons; the adapter converts nanotons->USD and
 * attaches `usdMicros`. Authenticity = the tx exists on-chain to our wallet.
 */
export class TonVerifier implements RailVerifier {
  readonly rail = "TON" as const;
  constructor(private readonly isAuthentic: AuthenticityCheck) {}

  verify(rawEvent: unknown): DomainResult<SettledPayment> {
    if (typeof rawEvent !== "object" || rawEvent === null) return err("event not an object");
    const e = rawEvent as Record<string, unknown>;
    const txHash = e["txHash"];
    const pack = asPack(e["pack"]);
    const userId = e["userId"];
    const usdMicros = e["usdMicros"];
    const at = e["at"];

    if (typeof txHash !== "string" || txHash.length === 0) return err("missing tx hash");
    if (!pack) return err("invalid or missing pack");
    if (typeof userId !== "string" || userId.length === 0) return err("missing userId");
    if (typeof usdMicros !== "number" || !Number.isFinite(usdMicros) || usdMicros <= 0) return err("invalid amount");

    if (!this.isAuthentic(txHash)) return err("TON transfer not found on-chain");

    return ok({
      rail: this.rail,
      providerTxId: txHash,
      paidMicros: usdMicros as UsdMicros,
      userId: userId as UserId,
      pack,
      at: typeof at === "number" ? at : Date.now(),
    });
  }
}

/** Convenience for building a USD-micros amount from whole dollars. */
export const dollars = (n: number): UsdMicros => usd(n);
