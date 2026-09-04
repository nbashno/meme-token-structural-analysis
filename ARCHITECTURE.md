# WAR — Architecture (Phase 1 Skeleton)

**Intelligence contract:** V3.2 FROZEN · **GMGN evidence:** `147c070` sealed · see `PHASE_0_SEALED.md`

This document is the boundary law. It is enforced by `tests/architecture`, not by good intentions.

---

## One-way data flow

```
GMGN / gmgn-cli
   ↓
src/adapters/gmgn        ← the ONLY place raw GMGN shapes exist
   ↓ (FlowEventNormalizer + Normalizer)
src/core/timeline        ← MARKET / FLOW / ANALYTICS lanes
   ↓
src/core/temporal → flow → trajectory → coherence
   ↓
src/core/power (Power / Threat / Confidence)
   ↓
src/core/state → events → signal → novelty → attention → evidence
   ↓
src/core/battlefield     ← BattlefieldState: the ONLY object leaving the core
   ═══════════ ONE WAY ═══════════
   ↓
src/physics              ← PhysicsProjector → MarketForceVector (visual only)
   ↓
(renderer / experience — NOT in this repo's core)
```

Data flows down only. Nothing below `battlefield` ever flows back up into the core.

---

## Import law (enforced by tests/architecture)

**`src/core/**` MUST NOT import:**
`src/adapters`, `src/physics`, `src/replay/outcome future-data paths`, `src/structure`,
and anything resembling a renderer, DOM, network, filesystem, React, Three.js, Pixi,
WebGL/WebGPU, `Date.now`, `Math.random`, or global mutable state.

**`src/structure/**` is GATED.** Verified at `147c070` but NOT admitted to core in the V1 build.
The core must compile and run with `src/structure` entirely absent. Nothing in `src/core`
imports from `src/structure`.

**`src/physics/**` may import** only `src/core/battlefield` types (BattlefieldState) and
renderer-facing config. It produces `MarketForceVector`. Nothing it produces returns to core.

**`src/adapters/gmgn/**` is the ONLY module** that may reference raw GMGN field names,
`is_open_or_close` raw values, or `hot_level`. `hot_level` dies at the adapter — it never
reaches `src/core`.

---

## Determinism law

Given identical (input, config, engineVersion, modelVersions) the core produces
byte-identical output. Therefore inside `src/core`:

- Time is **injected**, never read. No `Date.now()`, no `new Date()`.
- No `Math.random()`. Any procedural need takes an injected deterministic seed.
- No hidden mutable state, no nondeterministic iteration order, no ambient I/O.
- Missing data becomes explicit `UNKNOWN` / `null` + availability=false — **never `0`**.

---

## Anti-lookahead law

`engine(T)` may never access data at `T+1, T+2, …`. Only `src/outcome/OutcomeEvaluator`
may read post-decision future data, and only after a `DecisionRecord` is sealed. Replay
uses the exact same pipeline as live — no future leakage into past reconstruction.

---

## Standing prohibitions (from Phase 0 seal)

- `hot_level` → banned from core (dies at adapter).
- Causal attribution / `InfluenceGraph` → no official basis; forbidden. Co-funding is correlational only.
- `is_open_or_close` raw → never in core; normalized at adapter boundary per source (see contract).
- Renderer → intelligence backflow → forbidden.
- AI → deterministic score → forbidden. AI is downstream narration only.
