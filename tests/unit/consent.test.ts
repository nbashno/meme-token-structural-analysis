import { describe, it, expect } from "vitest";
import { ConsentLedger, CURRENT_LEGAL_VERSION } from "../../src/product/legal/consent.js";
import type { UserId } from "../../src/product/domain/identity.js";

const U = "u1" as UserId;

describe("ConsentLedger — auditable legal trail", () => {
  it("a new user has never consented and needs consent", () => {
    const l = new ConsentLedger();
    const s = l.status(U);
    expect(s.hasConsented).toBe(false);
    expect(s.needsConsent).toBe(true);
    expect(s.agreedVersion).toBeNull();
    expect(l.isCurrent(U)).toBe(false);
  });

  it("records an agreement to the current version and clears the gate", () => {
    const l = new ConsentLedger();
    l.record(U, CURRENT_LEGAL_VERSION, 1000, "miniapp");
    const s = l.status(U);
    expect(s.hasConsented).toBe(true);
    expect(s.needsConsent).toBe(false);
    expect(s.agreedVersion).toBe(CURRENT_LEGAL_VERSION);
    expect(s.agreedAt).toBe(1000);
    expect(l.isCurrent(U)).toBe(true);
  });

  it("requires re-consent when the legal version changes", () => {
    const l = new ConsentLedger("2026-02-v2"); // newer current version
    l.record(U, "2026-01-v1", 1000); // user agreed to the OLD version
    const s = l.status(U);
    expect(s.hasConsented).toBe(true);
    expect(s.needsConsent).toBe(true); // must agree again
    expect(s.agreedVersion).toBe("2026-01-v1");
    expect(s.currentVersion).toBe("2026-02-v2");
    expect(l.isCurrent(U)).toBe(false);
  });

  it("re-consenting to the new version clears the gate and keeps history", () => {
    const l = new ConsentLedger("2026-02-v2");
    l.record(U, "2026-01-v1", 1000);
    l.record(U, "2026-02-v2", 2000);
    expect(l.isCurrent(U)).toBe(true);
    expect(l.auditTrail(U)).toHaveLength(2); // full immutable history
    expect(l.latest(U)!.version).toBe("2026-02-v2");
    expect(l.latest(U)!.agreedAt).toBe(2000);
  });

  it("rejects an empty/blank version (no meaningless consent)", () => {
    const l = new ConsentLedger();
    expect(() => l.record(U, "", 1)).toThrow(/non-empty/);
    expect(() => l.record(U, "   ", 1)).toThrow(/non-empty/);
  });

  it("audit trail is a copy (cannot be mutated from outside)", () => {
    const l = new ConsentLedger();
    l.record(U, CURRENT_LEGAL_VERSION, 1);
    const trail = l.auditTrail(U) as unknown[];
    trail.push({ tampered: true });
    expect(l.auditTrail(U)).toHaveLength(1); // internal state unaffected
  });

  it("records provenance (source)", () => {
    const l = new ConsentLedger();
    l.record(U, CURRENT_LEGAL_VERSION, 1, "ton-wallet");
    expect(l.latest(U)!.source).toBe("ton-wallet");
  });
});
