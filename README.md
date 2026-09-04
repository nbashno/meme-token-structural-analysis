# WAR ARENA  -  Deterministic Meme-Coin Structural Analysis Engine

WAR ARENA is a multi-chain meme-coin market-intelligence engine. It does **not**
predict price. It reads the *structure* of a token on-chain  -  concentration,
liquidity absorption, organic activity, contract integrity, and more  -  and turns
that structure into a transparent, reproducible score plus a set of explainable
indices.

The core is a **deterministic** engine: given the same on-chain observations, it
always produces the same result. No randomness, no hidden state, no clock reads,
no network calls inside the scoring core. Every number it emits can be traced
back to a formula and a source field.

> **Positioning.** Most tools tell you *what a wallet did* or hand you a single
> opaque "risk %". WAR is an independent analysis layer that describes *how a
> token is built*  -  with the math shown, and missing data marked as missing
> rather than invented.

This repository is released as-is for study and reuse under the MIT license. It
is a snapshot of a working system; the hosted service is not guaranteed to be
running.

---

## What it does

- **WAR SCORE**  -  a weighted blend of structural indices (risk indices inverted),
  with a hard safety layer: a detected honeypot forces the score to 0; live
  mint/freeze authority caps the score; nothing can push the score *up*.
- **Nine structural indices**, each with its own formula and plain-language
  reading: absorption, concentration risk, organic activity, sniper load, smart
  conviction, contract integrity, flow balance, turnover, and ATH position.
- **Insufficient-data honesty**  -  any index without reliable inputs is marked
  `INSUFFICIENT` and excluded from the blend, which is then renormalised. The
  engine never fabricates a plausible-looking value.
- **Multi-chain resolution**  -  Solana, BSC, Base, and Ethereum, with automatic
  chain detection from an address.

### Scoring weights (frozen, V3.2)

| Index         | Weight | Notes                    |
|---------------|-------:|--------------------------|
| integrity     |     22 |                          |
| concentration |     20 | risk index -> inverted   |
| absorption    |     18 |                          |
| organic       |     15 |                          |
| snipers       |     10 | risk index -> inverted   |
| conviction    |      8 |                          |
| flow          |      7 |                          |

Weights are calibrated by hand in this release. Any future recalibration is
meant to be derived from empirical data distributions, not copied from external
platforms.

---

## Design principles

These are load-bearing, not decorative  -  the test suite enforces them.

1. **Deterministic core.** No `Date.now`, no `Math.random`, no `process.env`, no
   file/network IO anywhere the scoring engine can reach. Time enters as data.
2. **No data fabrication.** Missing input becomes `INSUFFICIENT` /
   `NOT_CONFIRMED`, never a guessed default.
3. **Anti-lookahead.** The engine at time *T* never sees data after *T*.
4. **Strict layering.** All SQL is confined to the persistence layer; raw
   provider payloads are normalised at the adapter boundary before the core sees
   them; architecture tests fail the build if a core file imports an adapter,
   physics, or IO.
5. **Independence.** WAR is an analysis layer *above* its data sources, not a
   reimplementation of any external scoring product.

---

## Architecture

```
Frontend (Telegram Mini App, single-file WebGL arena + vanilla JS)
      |  (Telegram initData auth)
Backend API (Express-style wired app, ~24 endpoints)
      |
WAR Runtime (dependency injection composition root)
      |
  +-------------+--------------+-------------+--------------+
  Engine         Persistence     Integration    Product
  (deterministic (Postgres        (data CLI,     (pricing,
   scoring)       stores)          RPC, alerts)   watch, intel)
```

- `src/product/analysis/warIndices.ts`  -  the scoring engine (the heart).
- `src/product/persistence/**`  -  all SQL lives here, nowhere else.
- `src/adapters/**`  -  raw payloads normalised into core observation types.
- `src/structure/**`  -  gated capabilities kept out of the deterministic core.

**Stack:** TypeScript, Node 22, Vitest for tests, PostgreSQL, Docker. The
frontend is a self-contained HTML/JS Mini App with a GPU-rendered arena used for
visualisation only  -  the physics never feed the engine.

**Scale:** 173 source files, 68 test files, 8 migrations, ~1,200 tests including
a dedicated architecture-guard suite.

---

## Getting started

> You will need your own data-provider credentials and a Postgres database. The
> engine core runs and is fully testable without any of them.

```bash
# install
npm install

# typecheck (strict)
npm run typecheck

# run the full test suite
npm test

# run only the architecture-boundary guards
npm run test:arch

# build
npm run build

# start (needs environment configured, see below)
npm start
```

### Environment

The service reads all secrets from environment variables  -  none are committed.
Provide your own values for the data-provider API key, Telegram bot token,
database URL, RPC endpoints, and related settings. See `src/deploy/env.ts` for
the full list of expected variables. Copy `.env.example` to `.env` and fill it
in for local runs.

---

## Status and scope

This is a snapshot of a personal project, opened for others to study and build
on. Some capabilities (for example a coordination / linked-wallet-cluster
detector under `src/structure`) exist as a frozen specification and a
stub-tested pure core, not a wired live feature  -  they are included because the
design and tests are useful reference material, not because they are finished.

Contributions and forks are welcome under the terms below. There is no support
commitment.

---

## License

MIT  -  see [LICENSE](./LICENSE). In short: do what you want, keep the copyright
notice, no warranty.

---

## Support

WAR ARENA is free and open source, built and maintained in spare time.
It will always be free. If it helped you and you'd like to say thanks,
a tip is appreciated but never expected - enjoy the project either way.

- Solana: `CxpR2rTWrQbsv2cEV5HJwpFMjYBhiURP6YJzJxxzo28P`
- EVM (ETH / BSC / Base): `0xA2fBd68B58C2Ac4194Fbbad82d2751467dE84A24`
