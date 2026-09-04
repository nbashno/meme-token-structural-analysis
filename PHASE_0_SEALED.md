# WAR — PHASE 0 SEALED RECORD

**Status:** `RATIFIED` · **Verdict:** `PASS_WITH_GATED_CAPABILITIES`
**Sealed:** 2026-08-21 · **Authority:** `GMGNAI/gmgn-skills` @ `147c070c502a9fe3ff845595db61a066a543161c`

This record freezes what was verified against the official source. It is evidence, not
opinion. Any future field promotion must cite a commit and a file path, or it does not happen.

---

## 1. Verification provenance

| Item | Value |
|---|---|
| Repository | `GMGNAI/gmgn-skills` (official) |
| Commit SHA | `147c070c502a9fe3ff845595db61a066a543161c` |
| Commit subject | `feat(holder-analysis): redesign output template for better readability (#203)` |
| Files read | `skills/gmgn-market/SKILL.md`, `skills/gmgn-track/SKILL.md`, `skills/gmgn-token/SKILL.md`, `skills/gmgn-holder-analysis/SKILL.md`, `skills/gmgn-holder-analysis/analyze.py`, `skills/gmgn-portfolio/SKILL.md`, `src/commands/track.ts`, `src/client/OpenApiClient.ts` |

⚠️ The pinned commit is from the sealing date and actively modified Structure surface (#203).
Structure is an upstream-volatile zone. Re-pin + re-verify before enabling Structure.

---

## 2. Substrate verdicts

| Substrate | Verdict | Core status in V1 build |
|---|---|---|
| MARKET (`market kline`, `market trending`) | VERIFIED | ENABLED |
| FLOW (`track kol` / `smartmoney` / `follow-wallet`) | VERIFIED | ENABLED |
| ANALYTICS (sampled trending / security) | VERIFIED | ENABLED |
| STRUCTURE (`token holders` / `traders`, funding) | VERIFIED (evidence-eligible) | **GATED — kept out of core by policy, not by evidence** |
| Real-time push cadence | BLOCKED | absent |

---

## 3. Four ratified corrections vs V3.2

| # | Correction | Repo truth | Action owed |
|---|---|---|---|
| 1 | Portfolio rate limit | `rate=20, capacity=20` (NOT `10/10`) | amend spec §44 |
| 2 | `is_open_or_close` semantics | fullness (follow-wallet) vs direction (kol/sm) — NOT an open/close flip | bind in Normalizer contract (see PHASE_0_flow_normalizer_contract.ts) |
| 3 | Flow field non-uniformity | `token_amount`, `quote_address`, `price_change` are source-specific | Normalizer branches per source |
| 4 | trending price-change spelling | `price_change_percent1m/5m/1h` (no underscore before window) | use repo spelling |

---

## 4. Status changes vs V3.2 (promotions & corrections)

Promoted `NOT_CONFIRMED → CONFIRMED_OFFICIAL` (all Structure-gated, none entering core yet):
`start_holding_at`, `end_holding_at`, `last_active_timestamp`,
`native_transfer {from_address, amount, timestamp}`, co-funding via shared `native_transfer.address`
(correlational only), `gmgn-holder-analysis` command, `token holders`/`token traders` schema.

Corrected: Portfolio `10/10 → 20/20`; `price_change_percent_1m → price_change_percent1m`;
`token_amount` generic → kol/sm only; `is_open_or_close` framing refined (see §3.2).

Unchanged: real-time push cadence remains `NOT_CONFIRMED`.

---

## 5. Standing prohibitions carried into V4

- `hot_level` — exists, CONFIRMED, but **BANNED from core** (un-normalized, time-incomparable).
- Causal attribution / `InfluenceGraph` — no official basis. Co-funding is correlational only.
- Structure fields — verified but **not** admitted to core in the V1 build. Second-layer, post-proof.
- `is_open_or_close` raw value — never enters core. Normalizer boundary only.
- No renderer → intelligence backflow. No AI → deterministic score. No future → past decision.

---

## 6. Definition of "sealed"

V3.2 Intelligence Contract remains FROZEN. Phase 0 is closed. V4 adds an Experience layer
strictly downstream of `PhysicsProjector`; it may not reopen any item above. The next
correctness artifact is the FlowEventNormalizer contract, because correction #2 is a
design-correctness blocker that must be settled before Phase 5.
