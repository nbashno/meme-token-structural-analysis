import { describe, it, expect, afterEach } from "vitest";
import { loadEnv, redactedEnv } from "../../src/deploy/env.js";

const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; });

describe("deploy env — validated typed config", () => {
  it("uses honest defaults when unset", () => {
    delete process.env["PORT"];
    delete process.env["HOST"];
    delete process.env["GMGN_API_KEY"];
    delete process.env["NODE_ENV"];
    const e = loadEnv();
    expect(e.port).toBe(8080);
    expect(e.host).toBe("0.0.0.0");
    expect(e.gmgnApiKey).toBeUndefined();
    expect(e.nodeEnv).toBe("development");
  });

  it("parses PORT as a number and throws on garbage", () => {
    process.env["PORT"] = "3000";
    expect(loadEnv().port).toBe(3000);
    process.env["PORT"] = "not-a-number";
    expect(() => loadEnv()).toThrow(/must be a number/);
  });

  it("normalizes NODE_ENV to a known value", () => {
    process.env["NODE_ENV"] = "production";
    expect(loadEnv().nodeEnv).toBe("production");
    process.env["NODE_ENV"] = "weird";
    expect(loadEnv().nodeEnv).toBe("development");
  });

  it("reads secrets but redaction never exposes their values", () => {
    process.env["GMGN_API_KEY"] = "super-secret-key";
    process.env["TELEGRAM_BOT_TOKEN"] = "123:secret";
    const e = loadEnv();
    expect(e.gmgnApiKey).toBe("super-secret-key");
    const r = redactedEnv(e);
    expect(r["gmgnApiKey"]).toBe("set");
    expect(r["telegramBotToken"]).toBe("set");
    // The redacted view must not contain the secret anywhere.
    expect(JSON.stringify(r)).not.toContain("super-secret-key");
    expect(JSON.stringify(r)).not.toContain("123:secret");
  });

  it("redaction reports unset secrets honestly", () => {
    delete process.env["GMGN_API_KEY"];
    delete process.env["TELEGRAM_BOT_TOKEN"];
    const r = redactedEnv(loadEnv());
    expect(r["gmgnApiKey"]).toBe("unset");
    expect(r["telegramBotToken"]).toBe("unset");
  });
});

describe("deploy server — import-safe (does not listen on import)", () => {
  it("can be imported without starting a server", async () => {
    // If importing started a server, the test runner would leak a handle.
    const mod = await import("../../src/deploy/server.js");
    expect(typeof mod.start).toBe("function");
  });
});
