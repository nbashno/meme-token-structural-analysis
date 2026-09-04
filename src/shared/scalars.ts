/**
 * WAR core — shared scalar contracts (Phase 2, types only).
 *
 * Branded nominal types make illegal states unrepresentable at the boundary.
 * A raw `number` cannot be assigned where a `Score0to100` is expected; it must
 * pass through a validating constructor (implemented in a later phase). These
 * brands carry no runtime cost — they are erased at compile time.
 *
 * LAW: Missing data is NEVER 0. Absence is modelled explicitly (see Maybe / Availability).
 */

declare const BRAND: unique symbol;
type Brand<T, B extends string> = T & { readonly [BRAND]: B };

/** A score constrained to the inclusive range [0, 100]. Never NaN, never Infinity. */
export type Score0to100 = Brand<number, "Score0to100">;

/** A ratio constrained to the inclusive range [0, 1]. Never NaN, never Infinity. */
export type Ratio0to1 = Brand<number, "Ratio0to1">;

/** A finite real number that is guaranteed neither NaN nor Infinity. */
export type FiniteNumber = Brand<number, "FiniteNumber">;

/** Unix timestamp in MILLISECONDS. WAR normalizes all time to ms internally. */
export type UnixMillis = Brand<number, "UnixMillis">;

/** Unix timestamp in SECONDS — only used at the adapter boundary before normalization. */
export type UnixSeconds = Brand<number, "UnixSeconds">;

/** A duration in milliseconds (non-negative). */
export type DurationMillis = Brand<number, "DurationMillis">;

/** A chain-scoped token contract address (opaque; validated at adapter). */
export type TokenAddress = Brand<string, "TokenAddress">;

/** A wallet address (opaque; validated at adapter). */
export type WalletAddress = Brand<string, "WalletAddress">;

/** The chains WAR supports, per sealed GMGN evidence. */
export type Chain = "sol" | "bsc" | "base" | "eth";

/**
 * Explicit optionality. Distinguishes "we looked and there is nothing"
 * (present:false) from "we have a value" (present:true). Prevents the
 * missing→zero collapse the intelligence contract forbids.
 */
export type Maybe<T> =
  | { readonly present: true; readonly value: T }
  | { readonly present: false };

/**
 * A measured quantity that may be unavailable, always paired with an
 * availability flag so downstream code cannot silently treat absence as 0.
 */
export interface Measured<T> {
  readonly value: T | null;
  readonly available: boolean;
}
