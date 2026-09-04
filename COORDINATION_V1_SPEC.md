# WAR — COORDINATION V1 · FROZEN SPEC (pre-code)

> Status: FROZEN (all technical dependencies verified against code; no open items).
> Scope: Solana only. Stub-first. No SCORE change. No AI. No graph DB. No multi-hop.
> Every claim below is grounded in the current codebase or the Helius `funded-by`
> docs, not assumption. Deviations from this document require explicit re-authorization.

---

## 0. One-paragraph intent

COORDINATION observes whether several wallets that traded the *same token* behave
as if they were **one entity** — same funding source, tightly clustered funding
and entry timing — and reports that as a **neutral observation with a link
strength**, never a verdict. It lives entirely behind the Verification Gate,
outside the deterministic WAR SCORE core. It changes nothing in V3.2.

---

## 1. Identity & naming (frozen)

| Concept | Frozen name | Why |
|---|---|---|
| The capability / indicator | `COORDINATION` | Broader than "bundle"; survives cases that aren't technically bundling |
| The detected entity | `LINKED_WALLET_CLUSTER` | Professional, provable on-chain; NOT "insider network" |
| The strength field | `linkStrength` | Deliberately NOT `confidence` — avoids collision with the frozen `confidence-v3` |
| The anchor wallet | `fundingAnchor` | The common funder that binds the cluster |

Forbidden output words in V1: `insider`, `rug`, `scam`, `safe`, `will`, any price
prediction. COORDINATION describes structure and behavior, not outcome.

---

## 2. Architectural placement (frozen, verified against code)

Verified facts from the repo:
- `src/structure/index.ts` is the gated home. Its own header states: *"Structure
  capability — GATED. Core must compile with this module absent. Nothing in
  src/core imports this."*
- `tests/architecture/boundaries.test.ts` lists `structure` in
  `FORBIDDEN_IMPORT_FRAGMENTS` for core, and bans `Date.now`, `new Date(`,
  `Math.random`, `process.env`, `node:fs/net/http` inside core.

Therefore:

```
WAR CORE V3.2  (9 signals + deterministic SCORE)
      │   ── NO CHANGE. Core never imports src/structure. ──
      ▼
VERIFICATION GATE   (OFF by default; single explicit toggle)
      ▼
src/structure/coordination/
      ├── FundingProvider        (IO boundary — the ONLY thing that touches network)
      ├── CoordinationDetector   (PURE — no IO, no Date.now, no Math.random)
      └── types                  (FundingRecord, WalletObservation, CoordinationObservation)
      ▼
WAR ALPHA MEMORY   (stores cluster observations, timestamped)
      ▼
[OFFLINE calibration — separate path, never read by scan engine]
```

Invariants (each becomes a load-bearing guard test — see §9):
- **C1** No file under `src/core` imports `src/structure` (already guarded; extend to cover the new dir).
- **C2** `CoordinationDetector` is pure: no `Date.now`, `new Date(`, `Math.random`, `process.env`, no network/fs imports. It receives time as data.
- **C3** The Verification Gate defaults OFF. With the gate off, no COORDINATION code path executes and no funding lookup is ever issued.
- **C4** SCORE is untouched: `WEIGHTS` in `warIndices.ts` is byte-identical; COORDINATION contributes 0 to the composite. (Breach test: assert `warScore` output is unchanged with COORDINATION present vs absent.)

---

## 3. Data sources (frozen, verified)

### 3.1 Entry data — already in the codebase, NO Helius tx history needed
Verified in `src/adapters/gmgn/FlowEventNormalizer.contract.ts` (`RawFlowEventCommon`):
```
maker            : string   → the wallet address        → WalletObservation.wallet
timestamp        : number   → unix seconds              → WalletObservation.entryTime
base_address     : string   → the token                 → WalletObservation.token
side             : "buy"|"sell" (via NormalizedFlowEvent, already interpreted)
transaction_hash : string   → provenance / dedupe
amount_usd, buy_cost_usd : string → reserved for V2 capital similarity
```
`getTransactionsForAddress` is **NOT used in V1**. Decision frozen.

### 3.2 Funding data — Helius `funded-by` (behind the gate)
Verified from `https://www.helius.dev/docs/wallet-api/funded-by`:
- Returns `funder, funderName, funderType, amount, timestamp, slot`.
- **Beta**, **paid plan** (Free → 403), tracks **first SOL transfer only**.
- `funderType` categories include Centralized Exchange, Cross-chain Bridge, DeFi,
  Market Maker, Validator, … or `null` (unknown).
- Docs state explicitly: funding source is the **immediate** funder, not the
  ultimate source. Funding data **never changes → cache permanently.**
- 404 when a wallet has no SOL funding tx (airdrop/program-init wallets).

---

## 4. Normalized types (source-agnostic — frozen shapes)

The Detector consumes ONLY these. It cannot tell Helius from Alchemy from GMGN.

```
WalletObservation
  wallet       : string
  token        : string
  side         : "buy" | "sell"        // from NormalizedFlowEvent, never raw is_open_or_close
  entryTime    : number | null         // null = INSUFFICIENT, not "no coordination"
  sim          : boolean               // MUST be false to proceed (see G1)

FundingRecord (normalized across chains)
  wallet          : string
  funder          : string | null      // null = 404/unknown → INSUFFICIENT
  funderType      : string | null      // null = unknown entity (a COORDINATION candidate)
  fundingTime     : number | null
  fundingAmount   : number | null
  sourceConfidence: "RESOLVED" | "INSUFFICIENT"

CoordinationObservation  (the output — neutral, no verdict)
  token           : string
  cluster         : LinkedWalletCluster | null
  status          : "OBSERVED" | "CANDIDATE" | "INSUFFICIENT" | "NONE"
  linkStrength    : "HIGH" | "MEDIUM" | "LOW" | "NONE"
  observedAt      : number             // injected as data (C2), never Date.now inside pure code

LinkedWalletCluster
  fundingAnchor   : string
  members         : string[]           // >= MIN_CLUSTER (3)
  commonFunder    : boolean
  fundingWindowSec: number | null
  entryWindowSec  : number | null
  supplyInvolved  : number | null      // % if derivable from confirmed data, else null
  evidence        : Evidence[]         // human-readable, ordered
```

---

## 5. Detector algorithm V1 (pure, deterministic — frozen)

Mirrors Helius's own `findWalletClusters` (group-by-funder) plus timing tests.

```
INPUT: candidateWallets[], fundingRecords[], entryObservations[], observedAt
1. Drop any observation with sim=true.                    (G1)
2. Drop wallets whose funderType ∈ {exchange, bridge,
   defi, market-maker, validator, stake-pool, system,
   fees, oracle}.  Keep funderType=null (candidate) and
   unknown-but-non-infra.                                 (G3)
3. Group surviving wallets by `funder`.
4. Keep groups with |members| >= MIN_CLUSTER (=3).
5. For each surviving group compute (only from present data):
     fundingWindowSec = max(fundingTime) - min(fundingTime)   | null if any missing
     entryWindowSec   = max(entryTime)   - min(entryTime)     | null if any entryTime null
     supplyInvolved   = Σ member supply share  | null if not derivable
6. linkStrength = f(commonFunder, fundingWindowSec, entryWindowSec, |members|)
     (thresholds are PLACEHOLDERS in V1 — see §7; NOT calibrated yet)
7. status:
     entryWindow present + funding tight   → OBSERVED
     common funder present, entry null     → CANDIDATE   (case B)
     funder null / 404 for the group       → INSUFFICIENT
     no group >= MIN_CLUSTER                → NONE
OUTPUT: CoordinationObservation
```

No `Math.random`, no `Date.now` — `observedAt` is passed in. This satisfies C2.

---

## 6. The two frozen cases (from your own analysis)

**Case A — full data → OBSERVED**
```
COORDINATION OBSERVED
3 wallets · common funder
funding window: 26s · entry window: 12s · supply: 14.2%
Link strength: HIGH
```

**Case B — funding present, entry unknown → CANDIDATE (never CONFIRMED, never NONE)**
```
COORDINATION CANDIDATE
Common funding relationship observed.
Entry timing: INSUFFICIENT
```

Absence of evidence is never rendered as evidence of absence. (Core WAR philosophy.)

---

## 7. Thresholds — EXPLICITLY UNCALIBRATED in V1 (frozen as placeholders)

These are engineering placeholders to make V1 runnable. They are NOT truth.
They will be replaced by offline calibration once ≥200–500 completed-cycle
observations exist. Until then, every COORDINATION card carries the footer:
*"Thresholds provisional — not yet calibrated on WAR data."*

```
MIN_CLUSTER        = 3
FUNDING_WINDOW_TIGHT_SEC = 120     placeholder
ENTRY_WINDOW_TIGHT_SEC   = 60      placeholder
linkStrength HIGH   = commonFunder && fundingTight && entryTight && members>=4
             MEDIUM = commonFunder && (fundingTight || entryTight)
             LOW    = commonFunder only
             NONE   = otherwise
```

---

## 8. The six guards (each proven load-bearing with a breach-planting test)

- **G1 sim-reject:** a `sim:true` maker must NEVER reach FundingProvider. Breach test: feed a `sim:true` wallet, assert zero funding lookups issued and status≠OBSERVED.
- **G2 404→INSUFFICIENT:** a 404 from `funded-by` yields `sourceConfidence:"INSUFFICIENT"`, never `funder:""` or a dropped-silently wallet.
- **G3 infra-exclude / null-keep:** known-infra funderTypes are excluded; `funderType:null` is KEPT as a candidate (the counter-intuitive but correct rule).
- **G4 entry-null→CANDIDATE:** null entryTime produces CANDIDATE, never NONE and never OBSERVED.
- **G5 no-multi-hop:** the Detector must not recurse on funders-of-funders. Breach test: a 2-hop chain must not be collapsed into one cluster.
- **G6 gate-off-silent:** with the Verification Gate OFF, no COORDINATION code executes and no network call is made. Breach test: gate off + a token that would cluster → zero lookups, empty output.

Plus the four architectural invariants C1–C4 (§2) as guard tests.

---

## 9. Stub-first contract (frozen — build order)

Per your standing principle *stubs ≠ mocks*: the stub replaces the network only;
all Detector math runs for real.

```
FundingProvider (interface)
  getFunding(wallets: string[]): FundingRecord[]

StubFundingProvider   — returns fixed FundingRecords from a fixture. No network.
HeliusFundingProvider — real, behind the gate, with permanent cache. Built ONLY
                        after the Detector + all guards pass on the stub.
```

Build order (frozen):
1. types + Detector (pure) + full unit tests + breach tests for G1–G6, C1–C4.
2. StubFundingProvider + the two case fixtures (A, B).
3. Wire behind the Verification Gate (still OFF by default).
4. Scan-mode card (neutral display) + Alpha Memory write (timestamped).
5. ONLY THEN: HeliusFundingProvider (paid, cached) — separate, reviewable step.

Explicitly OUT of V1 (frozen deferrals): capital similarity, repeated
cross-token coordination, Network Memory, multi-hop, EVM (Alchemy), monitor-mode
live cluster feed, and any SCORE integration. Each is a later, separately
authorized decision.

---

## 10. What V1 must NOT do (frozen)

❌ touch `warIndices.ts` WEIGHTS or the composite
❌ introduce IO, Date.now, or Math.random into anything core imports
❌ run on trending / sim:true wallets
❌ emit a verdict, a risk number, or a price expectation
❌ multi-hop funding tracing
❌ open `confidence-v3`
❌ ship HeliusFundingProvider before the stub path is fully guarded

---

## 11. candidateWallets source — RESOLVED (verified, no open item)

Verified in `src/product/scan/ports/ports.ts`: the scan orchestrator already
receives `NormalizedObservations`, which carries
`flow: readonly FlowObservation[]`. Each `FlowObservation` carries `maker`
(wallet), `at` (entry time), and `side`.

Decision (frozen): **V1 needs no new discovery step.**
```
candidateWallets = observations.flow
                     .filter(f => sim(f) === false)   // G1
                     .map(f => f.maker)               // dedupe
```
No "first N buyers" call, no extra acquisition, no new dependency. The Detector
receives the makers already surfaced by the existing sealed flow path. This keeps
the entire entry-side of COORDINATION inside data WAR already has; only the
funding-side (Helius) is new, and it stays behind the gate.

Note: `FlowObservation` does not itself carry the `sim` flag today — the flag
lives at the UI/data-mode layer. V1 build step 1 adds a `sim`/provenance check at
the FundingProvider boundary keyed on `meta.provenance` (`track.*` = real).
Trending-derived synthetic makers never reach this path because COORDINATION is
invoked only on the real scan flow, never on the trending feed (§10).
