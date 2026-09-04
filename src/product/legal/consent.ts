/**
 * WAR Product Layer — consent ledger (legal audit trail).
 *
 * Records that a user agreed to a specific version of the Terms + Privacy at a
 * point in time. This is the durable, auditable proof of consent the Mini App's
 * gate implies. It is intentionally simple and honest:
 *   - Consent is versioned (LEGAL_VERSION). If the current legal version is
 *     newer than the user's last agreement, they must re-consent.
 *   - A record is immutable once written; a new agreement appends a new record.
 *   - No consent is ever fabricated — absence of a record means "not agreed".
 *
 * No intelligence, no scoring. Pure legal record-keeping over an injected clock.
 */

import type { UserId } from "../domain/identity.js";

/** The current legal version. Bump when Terms/Privacy change materially. */
export const CURRENT_LEGAL_VERSION = "2026-01-v1";

export interface ConsentRecord {
  readonly userId: UserId;
  /** Legal version the user agreed to. */
  readonly version: string;
  /** When they agreed (UnixMillis, injected clock). */
  readonly agreedAt: number;
  /** Optional provenance: which rail/UA/source recorded it. */
  readonly source: string;
}

export interface ConsentStatus {
  readonly hasConsented: boolean;
  /** True when a fresh agreement is required (never agreed, or version changed). */
  readonly needsConsent: boolean;
  readonly currentVersion: string;
  readonly agreedVersion: string | null;
  readonly agreedAt: number | null;
}

export class ConsentLedger {
  /** Full history per user, newest last. */
  private readonly history = new Map<UserId, ConsentRecord[]>();

  constructor(private readonly currentVersion: string = CURRENT_LEGAL_VERSION) {}

  /**
   * Record an agreement to a version. Rejects an empty/unknown version to avoid
   * recording a meaningless consent. Appends; never overwrites history.
   */
  record(userId: UserId, version: string, agreedAt: number, source = "miniapp"): ConsentRecord {
    if (typeof version !== "string" || version.trim() === "") {
      throw new Error("consent version must be a non-empty string");
    }
    const rec: ConsentRecord = { userId, version, agreedAt, source };
    const list = this.history.get(userId) ?? [];
    list.push(rec);
    this.history.set(userId, list);
    return rec;
  }

  /** The user's most recent agreement, or null. */
  latest(userId: UserId): ConsentRecord | null {
    const list = this.history.get(userId);
    if (!list || list.length === 0) return null;
    return list[list.length - 1]!;
  }

  /**
   * Status for gating. needsConsent is true when the user has never agreed, or
   * agreed to an older version than the current one. This is what the API/gate
   * checks before allowing entry to paid or personal features.
   */
  status(userId: UserId): ConsentStatus {
    const latest = this.latest(userId);
    if (!latest) {
      return { hasConsented: false, needsConsent: true, currentVersion: this.currentVersion, agreedVersion: null, agreedAt: null };
    }
    const needsConsent = latest.version !== this.currentVersion;
    return {
      hasConsented: true,
      needsConsent,
      currentVersion: this.currentVersion,
      agreedVersion: latest.version,
      agreedAt: latest.agreedAt,
    };
  }

  /** True when the user may proceed (has agreed to the current version). */
  isCurrent(userId: UserId): boolean {
    return !this.status(userId).needsConsent;
  }

  /** Full immutable audit trail for a user (e.g. for a legal/data request). */
  auditTrail(userId: UserId): readonly ConsentRecord[] {
    return [...(this.history.get(userId) ?? [])];
  }
}
