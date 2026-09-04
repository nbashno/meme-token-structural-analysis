import { describe, it, expect } from "vitest";
import { MembershipGate } from "../../src/product/legal/membershipGate.js";
import type { UserId } from "../../src/product/domain/identity.js";

const U = "u1" as UserId;
const TG = "42";

describe("MembershipGate", () => {
  it("allows everyone when no channel is configured (feature off)", async () => {
    const g = new MembershipGate({ requiredChannel: undefined }, async () => null);
    expect(g.isEnabled()).toBe(false);
    const v = await g.check(U, TG);
    expect(v.allowed).toBe(true);
  });

  it("allows confirmed members (member/administrator/creator)", async () => {
    for (const status of ["member", "administrator", "creator", "restricted"]) {
      const g = new MembershipGate({ requiredChannel: "@war" }, async () => status);
      const v = await g.check(U, TG);
      expect(v.allowed, `status ${status}`).toBe(true);
    }
  });

  it("blocks non-members (left/kicked)", async () => {
    for (const status of ["left", "kicked"]) {
      const g = new MembershipGate({ requiredChannel: "@war" }, async () => status);
      const v = await g.check(U, TG);
      expect(v.allowed, `status ${status}`).toBe(false);
      expect(v.channel).toBe("@war");
    }
  });

  it("fails CLOSED when membership cannot be determined (null / throw)", async () => {
    const gNull = new MembershipGate({ requiredChannel: "@war" }, async () => null);
    expect((await gNull.check(U, TG)).allowed).toBe(false);
    const gThrow = new MembershipGate({ requiredChannel: "@war" }, async () => { throw new Error("net"); });
    expect((await gThrow.check(U, TG)).allowed).toBe(false);
  });

  it("passes the channel + telegram id to the checker", async () => {
    let seen: { channel: string; id: string } | null = null;
    const g = new MembershipGate({ requiredChannel: "@war" }, async (channel, id) => { seen = { channel, id }; return "member"; });
    await g.check(U, TG);
    expect(seen).toEqual({ channel: "@war", id: "42" });
  });
});
