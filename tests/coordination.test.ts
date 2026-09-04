import { describe, it, expect } from "vitest";
import { detectCoordination } from "../src/structure/coordination/detector.js";
import type {
  WalletObservation,
  FundingRecord,
} from "../src/structure/coordination/types.js";

const TOKEN = "TOKENxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const OBS_AT = 1_700_000_000;

function w(
  wallet: string,
  entryTime: number | null,
  extra: Partial<WalletObservation> = {},
): WalletObservation {
  return {
    wallet,
    token: TOKEN,
    side: "buy",
    entryTime,
    sim: false,
    ...extra,
  };
}
function fund(
  wallet: string,
  funder: string | null,
  fundingTime: number | null,
  extra: Partial<FundingRecord> = {},
): FundingRecord {
  return {
    wallet,
    funder,
    funderType: null,
    fundingTime,
    fundingAmount: null,
    sourceConfidence: funder === null ? "INSUFFICIENT" : "RESOLVED",
    ...extra,
  };
}

describe("CoordinationDetector — case A (full data → OBSERVED)", () => {
  it("clusters 3 wallets sharing a funder with tight funding+entry windows", () => {
    const wallets = [
      w("A", 5011),
      w("B", 5018),
      w("C", 5023),
    ];
    const funding = [
      fund("A", "FUNDER_X", 4003),
      fund("B", "FUNDER_X", 4021),
      fund("C", "FUNDER_X", 4029),
    ];
    const out = detectCoordination(TOKEN, wallets, funding, OBS_AT);
    expect(out.status).toBe("OBSERVED");
    expect(out.cluster?.members.slice().sort()).toEqual(["A", "B", "C"]);
    expect(out.cluster?.commonFunder).toBe(true);
    expect(out.cluster?.fundingWindowSec).toBe(26);
    expect(out.cluster?.entryWindowSec).toBe(12);
    expect(out.cluster?.evidence).toContain("FUNDING_PROXIMITY");
    expect(out.cluster?.evidence).toContain("ENTRY_PROXIMITY");
    expect(out.thresholdsCalibrated).toBe(false);
  });

  it("HIGH strength needs >=4 members plus both windows tight", () => {
    const wallets = [w("A", 10), w("B", 12), w("C", 14), w("D", 16)];
    const funding = [
      fund("A", "X", 100),
      fund("B", "X", 105),
      fund("C", "X", 110),
      fund("D", "X", 118),
    ];
    const out = detectCoordination(TOKEN, wallets, funding, OBS_AT);
    expect(out.linkStrength).toBe("HIGH");
    expect(out.cluster?.evidence).toContain("CLUSTER_SIZE");
  });
});

describe("G4 — case B (funding present, entry null → CANDIDATE, never NONE/OBSERVED)", () => {
  it("emits CANDIDATE when entryTime is null for members", () => {
    const wallets = [w("A", null), w("B", null), w("C", null)];
    const funding = [
      fund("A", "X", 400),
      fund("B", "X", 410),
      fund("C", "X", 420),
    ];
    const out = detectCoordination(TOKEN, wallets, funding, OBS_AT);
    expect(out.status).toBe("CANDIDATE");
    expect(out.status).not.toBe("NONE");
    expect(out.status).not.toBe("OBSERVED");
    expect(out.cluster?.entryWindowSec).toBeNull();
  });
});

describe("G1 — sim-reject: synthetic/trending makers never cluster", () => {
  it("drops sim:true wallets before any clustering", () => {
    const wallets = [
      w("A", 10, { sim: true }),
      w("B", 12, { sim: true }),
      w("C", 14, { sim: true }),
    ];
    const funding = [
      fund("A", "X", 1),
      fund("B", "X", 2),
      fund("C", "X", 3),
    ];
    const out = detectCoordination(TOKEN, wallets, funding, OBS_AT);
    expect(out.status).toBe("NONE");
    expect(out.cluster).toBeNull();
  });
});

describe("G2 — 404/INSUFFICIENT funding is tracked, not silently dropped", () => {
  it("surfaces INSUFFICIENT when funding is missing for would-be members", () => {
    const wallets = [w("A", 10), w("B", 12), w("C", 14)];
    const funding = [
      fund("A", null, null), // 404
      fund("B", null, null),
      fund("C", null, null),
    ];
    const out = detectCoordination(TOKEN, wallets, funding, OBS_AT);
    expect(out.status).toBe("INSUFFICIENT");
    expect(out.cluster).toBeNull();
  });
});

describe("G3 — infra-exclude, null-keep", () => {
  it("excludes known-infra funderType (shared exchange is not a cluster)", () => {
    const wallets = [w("A", 10), w("B", 12), w("C", 14)];
    const funding = [
      fund("A", "BINANCE", 1, { funderType: "Centralized Exchange" }),
      fund("B", "BINANCE", 2, { funderType: "Centralized Exchange" }),
      fund("C", "BINANCE", 3, { funderType: "Centralized Exchange" }),
    ];
    const out = detectCoordination(TOKEN, wallets, funding, OBS_AT);
    // all excluded as infra → no eligible members → NONE (none were insufficient)
    expect(out.status).toBe("NONE");
  });

  it("KEEPS funderType=null (unknown funder is a coordination candidate)", () => {
    const wallets = [w("A", 10), w("B", 12), w("C", 14)];
    const funding = [
      fund("A", "MYSTERY", 100, { funderType: null }),
      fund("B", "MYSTERY", 105, { funderType: null }),
      fund("C", "MYSTERY", 110, { funderType: null }),
    ];
    const out = detectCoordination(TOKEN, wallets, funding, OBS_AT);
    expect(out.status).toBe("OBSERVED");
    expect(out.cluster?.fundingAnchor).toBe("MYSTERY");
  });
});

describe("G5 — no multi-hop: funder-of-funder is never collapsed", () => {
  it("a 2-hop chain does not merge into one cluster", () => {
    // A←B, C←B, D←B would cluster on B. But a chain A←M, C←N, D←O where
    // M,N,O are themselves funded by B must NOT collapse to B (no recursion).
    const wallets = [w("A", 10), w("C", 12), w("D", 14)];
    const funding = [
      fund("A", "M", 100),
      fund("C", "N", 105),
      fund("D", "O", 110),
      // even if we were told M,N,O share ancestor B, the detector must ignore it
      fund("M", "B", 1),
      fund("N", "B", 2),
      fund("O", "B", 3),
    ];
    const out = detectCoordination(TOKEN, wallets, funding, OBS_AT);
    // Each token-buyer has a distinct immediate funder → no group reaches size 3.
    expect(out.status).toBe("NONE");
    expect(out.cluster).toBeNull();
  });
});

describe("G6 — determinism: pure, repeatable, order-independent", () => {
  it("identical inputs yield identical output (no clock/random)", () => {
    const wallets = [w("A", 10), w("B", 12), w("C", 14)];
    const funding = [fund("A", "X", 1), fund("B", "X", 2), fund("C", "X", 3)];
    const a = detectCoordination(TOKEN, wallets, funding, OBS_AT);
    const b = detectCoordination(TOKEN, wallets, funding, OBS_AT);
    expect(a).toEqual(b);
  });

  it("wallet input order does not change the cluster", () => {
    const funding = [fund("A", "X", 1), fund("B", "X", 2), fund("C", "X", 3)];
    const a = detectCoordination(
      TOKEN,
      [w("A", 10), w("B", 12), w("C", 14)],
      funding,
      OBS_AT,
    );
    const b = detectCoordination(
      TOKEN,
      [w("C", 14), w("A", 10), w("B", 12)],
      funding,
      OBS_AT,
    );
    expect(a.cluster?.members.slice().sort()).toEqual(
      b.cluster?.members.slice().sort(),
    );
    expect(a.status).toBe(b.status);
    expect(a.linkStrength).toBe(b.linkStrength);
  });

  it("below MIN_CLUSTER (2 wallets) → NONE", () => {
    const out = detectCoordination(
      TOKEN,
      [w("A", 10), w("B", 12)],
      [fund("A", "X", 1), fund("B", "X", 2)],
      OBS_AT,
    );
    expect(out.status).toBe("NONE");
  });
});

describe("purity guard — source has no clock/random/IO tokens", () => {
  it("detector.ts contains no forbidden runtime tokens", async () => {
    const fs = await import("node:fs");
    const url = new URL(
      "../src/structure/coordination/detector.ts",
      import.meta.url,
    );
    const raw = fs.readFileSync(url, "utf8");
    // Strip comments so the guard inspects executable code, not prose that
    // legitimately names the banned tokens (mirrors boundaries.test.ts intent).
    const src = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    for (const banned of ["Date.now", "new Date(", "Math.random", "process.env"]) {
      expect(src.includes(banned)).toBe(false);
    }
  });
});
