/**
 * WAR Product Layer - Phase 1 - identity + shared domain scalars.
 *
 * These are PRODUCT-domain types. They sit ABOVE WAR Core and never leak into it.
 * The Product Layer consumes Core contracts from "war-engine" (the public barrel);
 * it never imports src/core/** internals and never touches raw GMGN payloads.
 *
 * LAW inherited from Core: absence is explicit, time is injected, no ambient IO,
 * no Date.now / Math.random in pure domain logic. Determinism is a product
 * invariant too, not only a Core one.
 */

import type { Chain, TokenAddress } from "../../shared/scalars.js";

// -- Identity -----------------------------------------------------------------

/** Abstract user identity. Telegram is the FIRST client, never the only one. */
export type UserId = string & { readonly __brand: "UserId" };

/** The auth provider that vouches for a user. */
export type IdentityProvider = "TELEGRAM" | "TON_WALLET" | "SYSTEM";

export interface UserIdentity {
  readonly userId: UserId;
  readonly provider: IdentityProvider;
  /** The provider's native id (e.g. Telegram user id). Opaque to the domain. */
  readonly providerUserId: string;
  readonly createdAt: number; // UnixMillis (product clock, injected)
}

/**
 * Canonical token identity. NEVER a bare symbol - a symbol is metadata only.
 * Identity is (chain + address), matching the Core's TokenAddress brand.
 */
export interface TokenId {
  readonly chain: Chain;
  readonly address: TokenAddress;
}

/** Human-facing metadata; decorative only, never an identity key. */
export interface TokenMetadata {
  readonly symbol?: string;
  readonly name?: string;
}

// -- Money (USD-canonical) ----------------------------------------------------

/**
 * Prices are defined in USD-equivalent terms. Payment adapters convert to the
 * actual Stars/TON amount via PricingService. USD micros avoid float drift:
 * 1 USD = 1_000_000 micros. $0.10 = 100_000; $1.00 = 1_000_000.
 */
export type UsdMicros = number & { readonly __brand: "UsdMicros" };

export function usd(dollars: number): UsdMicros {
  // Deterministic integer conversion; rounds to nearest micro.
  return Math.round(dollars * 1_000_000) as UsdMicros;
}

export function usdMicrosToDollars(m: UsdMicros): number {
  return (m as number) / 1_000_000;
}

// -- Product time -------------------------------------------------------------

/**
 * The Product Layer needs a real clock for sessions/expiry, but it must be
 * INJECTED, never ambient. A Clock is a value the caller threads in, so every
 * lifecycle computation stays deterministic and testable.
 */
export interface Clock {
  now(): number; // UnixMillis
}

/** A fixed clock for deterministic tests / replay. */
export function fixedClock(atMs: number): Clock {
  return { now: () => atMs };
}

// -- Result helper ------------------------------------------------------------

/** Explicit success/failure without exceptions in pure domain logic. */
export type DomainResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

export function ok<T>(value: T): DomainResult<T> {
  return { ok: true, value };
}
export function err<T>(error: string): DomainResult<T> {
  return { ok: false, error };
}

/** Equality for token identity (chain-scoped). */
export function tokenKey(t: TokenId): string {
  return `${t.chain}:${t.address as string}`;
}
