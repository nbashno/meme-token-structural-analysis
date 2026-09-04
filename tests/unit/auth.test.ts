import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyTelegramInitData } from "../../src/auth/telegramAuth.js";
import { deriveUserId, telegramIdentity } from "../../src/auth/identityMapper.js";
import { authenticate, extractInitData } from "../../src/auth/authMiddleware.js";

const BOT = "123456:TEST_BOT_TOKEN";

/** Build a correctly-signed initData string, exactly as Telegram would. */
function signInitData(fields: Record<string, string>, botToken = BOT): string {
  const dcs = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secret).update(dcs).digest("hex");
  const all = { ...fields, hash };
  return Object.entries(all).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
}

const NOW = 1_700_000_000;
const userJson = JSON.stringify({ id: 42, first_name: "Suhib", username: "suhib", language_code: "ar" });

describe("telegram initData verification — real HMAC", () => {
  it("accepts a correctly signed, fresh payload", () => {
    const initData = signInitData({ auth_date: String(NOW - 10), user: userJson });
    const r = verifyTelegramInitData(initData, BOT, { nowSeconds: NOW });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.user.id).toBe("42");
      expect(r.user.username).toBe("suhib");
      expect(r.user.languageCode).toBe("ar");
    }
  });

  it("rejects a tampered payload (hash mismatch)", () => {
    let initData = signInitData({ auth_date: String(NOW - 10), user: userJson });
    initData = initData.replace("Suhib", "Attacker"); // change data, hash no longer matches
    const r = verifyTelegramInitData(initData, BOT, { nowSeconds: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("hash mismatch");
  });

  it("rejects the wrong bot token", () => {
    const initData = signInitData({ auth_date: String(NOW - 10), user: userJson }, "other:TOKEN");
    const r = verifyTelegramInitData(initData, BOT, { nowSeconds: NOW });
    expect(r.ok).toBe(false);
  });

  it("rejects expired initData", () => {
    const initData = signInitData({ auth_date: String(NOW - 100000), user: userJson });
    const r = verifyTelegramInitData(initData, BOT, { nowSeconds: NOW, maxAgeSeconds: 3600 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("initData expired");
  });

  it("rejects missing hash / user / auth_date and never throws on garbage", () => {
    expect(verifyTelegramInitData("", BOT, { nowSeconds: NOW }).ok).toBe(false);
    expect(verifyTelegramInitData("garbage=1", BOT, { nowSeconds: NOW }).ok).toBe(false);
    const noUser = signInitData({ auth_date: String(NOW - 10) });
    const r = verifyTelegramInitData(noUser, BOT, { nowSeconds: NOW });
    expect(r.ok).toBe(false);
  });
});

describe("identity mapping — stable, provider-scoped", () => {
  it("same telegram id -> same UserId", () => {
    expect(deriveUserId("TELEGRAM", "42")).toBe(deriveUserId("TELEGRAM", "42"));
  });
  it("different providers never collide", () => {
    expect(deriveUserId("TELEGRAM", "42")).not.toBe(deriveUserId("TON_WALLET", "42"));
  });
  it("builds a domain UserIdentity", () => {
    const id = telegramIdentity({ id: "42", username: "suhib" }, 1700000000000);
    expect(id.provider).toBe("TELEGRAM");
    expect(id.providerUserId).toBe("42");
    expect(id.createdAt).toBe(1700000000000);
    expect(id.userId.startsWith("telegram_")).toBe(true);
  });
});

describe("auth middleware", () => {
  it("authenticates a valid request into a domain identity", () => {
    const initData = signInitData({ auth_date: String(NOW - 10), user: userJson });
    const r = authenticate({ botToken: BOT }, { initData, nowSeconds: NOW, nowMillis: NOW * 1000 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity.providerUserId).toBe("42");
  });
  it("rejects missing initData with 401", () => {
    const r = authenticate({ botToken: BOT }, { initData: undefined, nowSeconds: NOW, nowMillis: NOW * 1000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });
  it("extractInitData reads header, then body, then query", () => {
    expect(extractInitData({ "x-telegram-init-data": "H" }, null, {})).toBe("H");
    expect(extractInitData({}, { initData: "B" }, {})).toBe("B");
    expect(extractInitData({}, null, { initData: "Q" })).toBe("Q");
    expect(extractInitData({}, null, {})).toBeUndefined();
  });
});
