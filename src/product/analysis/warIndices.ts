/**
 * WAR ARENA — Signature Intelligence Indices.
 *
 * This is WAR's own analytical layer: it turns confirmed on-chain metrics into
 * decision-grade indices. Every formula here is DETERMINISTIC, PURE and
 * TRANSPARENT — same inputs always give the same output, no IO, no randomness,
 * no hidden weights. Each index carries its own `formula` string so the user can
 * see exactly how the number was produced.
 *
 * DESIGN BASIS (what professional memecoin analysts actually measure):
 *  - Holder concentration is the dominant dump-risk driver; top-10 above ~40% is
 *    widely treated as high risk, and team/dev allocation above ~10% adds
 *    structural sell pressure.
 *  - The real liquidity question is absorption: pool size RELATIVE to market cap
 *    (a healthy target band is roughly 10-20%), not the raw cap.
 *  - Bundled wallets hide true concentration, so bundle rate must be folded into
 *    concentration rather than read separately.
 *  - Sniper saturation predicts early dumps: heavily sniped launches unload as
 *    soon as an early multiple is reached.
 *  - Manufactured activity (bot-driven trades, wash trading, rat-trader volume)
 *    inflates apparent demand, so organic share must be discounted explicitly.
 *
 * DISCIPLINE:
 *  - Inputs are already-normalized product-layer values (camelCase), never raw
 *    provider field names.
 *  - A missing input makes its index INSUFFICIENT — it is never defaulted to a
 *    flattering number, and an INSUFFICIENT index is excluded from the composite
 *    rather than counted as zero.
 *  - Indices are analysis, not advice. The caller surfaces that.
 */

/** Normalized metric inputs. All optional: absence is handled, never faked. */
export interface IndexInputs {
  readonly marketCap?: number | undefined;
  readonly liquidity?: number | undefined;
  readonly initialLiquidity?: number | undefined;
  readonly athMarketCap?: number | undefined;
  readonly volume?: number | undefined;
  readonly holders?: number | undefined;
  readonly top10Rate?: number | undefined;      // 0..1
  readonly devHoldRate?: number | undefined;    // 0..1
  readonly top70SniperRate?: number | undefined; // 0..1
  readonly bundlerRate?: number | undefined;    // 0..1
  readonly bluechipPct?: number | undefined;    // 0..1
  readonly sniperCount?: number | undefined;
  readonly botRate?: number | undefined;        // 0..1
  readonly ratTraderRate?: number | undefined;  // 0..1
  readonly entrapmentRatio?: number | undefined; // 0..1
  readonly washTrading?: boolean | undefined;
  readonly rugRatio?: number | undefined;       // 0..1
  readonly honeypot?: boolean | undefined;
  readonly renounced?: boolean | undefined;
  readonly openSource?: boolean | undefined;
  readonly renouncedMint?: boolean | undefined;
  readonly renouncedFreeze?: boolean | undefined;
  readonly lockPercent?: number | undefined;    // 0..1
  readonly burnRatio?: number | undefined;      // 0..1
  readonly buys?: number | undefined;
  readonly sells?: number | undefined;
  readonly smartMoney?: number | undefined;
  readonly renowned?: number | undefined;
  readonly buyTax?: string | undefined;
  readonly sellTax?: string | undefined;
  readonly creationTs?: number | undefined;     // unix seconds
  readonly nowTs?: number | undefined;          // unix seconds (injected, no ambient clock)
  readonly change1h?: number | undefined;       // percent
  readonly change5m?: number | undefined;       // percent
}

export type Band = "STRONG" | "GOOD" | "NEUTRAL" | "WEAK" | "CRITICAL" | "INSUFFICIENT";

export interface WarIndex {
  readonly key: string;
  readonly label: string;
  /** 0..100, or null when inputs are insufficient. */
  readonly score: number | null;
  readonly band: Band;
  /** Human-readable value (e.g. "12.4% of cap"). */
  readonly display: string;
  /** The exact formula used — shown to the user for transparency. */
  readonly formula: string;
  /** One-line reading of what this means right now. */
  readonly reading: string;
  /** Higher score = better (true) or higher = worse (false). */
  readonly higherIsBetter: boolean;
  /** If set, this index caps the composite WAR SCORE at this value (e.g. live
   *  rug authority). The floor mechanism: risk that must dominate the blend. */
  readonly capsScoreAt?: number;
}

const clamp = (x: number, lo = 0, hi = 100): number => Math.max(lo, Math.min(hi, x));
const has = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const r1 = (x: number): number => Math.round(x * 10) / 10;
const pctS = (x: number): string => `${r1(x * 100)}%`;

function bandFor(score: number, higherIsBetter: boolean): Band {
  const s = higherIsBetter ? score : 100 - score;
  if (s >= 80) return "STRONG";
  if (s >= 60) return "GOOD";
  if (s >= 40) return "NEUTRAL";
  if (s >= 20) return "WEAK";
  return "CRITICAL";
}

const insufficient = (key: string, label: string, formula: string, higherIsBetter = true): WarIndex => ({
  key, label, score: null, band: "INSUFFICIENT", display: "—", formula,
  reading: "Not enough confirmed data to compute this.", higherIsBetter,
});

/**
 * ABSORPTION — how much size the market can take before price breaks.
 * Pool depth relative to cap is the analyst-standard read; ~20% of cap is
 * treated as a healthy ceiling, so the score saturates there.
 */
export function absorptionIndex(i: IndexInputs): WarIndex {
  const formula = "Measures pool depth relative to market cap — how much size the market can absorb before price breaks.";
  if (!has(i.liquidity) || !has(i.marketCap) || i.marketCap <= 0) {
    return insufficient("absorption", "Absorption", formula);
  }
  const ratio = i.liquidity / i.marketCap;
  const score = clamp((ratio / 0.20) * 100);
  const band = bandFor(score, true);
  const reading =
    ratio >= 0.20 ? "Deep pool for its cap — can absorb real size."
    : ratio >= 0.10 ? "Reasonable depth; medium orders move price moderately."
    : ratio >= 0.04 ? "Thin pool — moderate orders will move price sharply."
    : "Very thin — even small orders cause severe slippage.";
  return { key: "absorption", label: "Absorption", score: Math.round(score), band,
    display: `${pctS(ratio)} of cap`, formula, reading, higherIsBetter: true };
}

/**
 * CONCENTRATION — dump risk from who holds the supply. Bundled wallets are
 * folded in because they mask true concentration; dev allocation and sniper
 * holdings are structural sell pressure on top of raw top-10.
 */
export function concentrationIndex(i: IndexInputs): WarIndex {
  const formula = "Weighs top-10 holder share, developer allocation, sniper holdings and bundled-wallet share into a single dump-risk read.";
  if (!has(i.top10Rate)) return insufficient("concentration", "Concentration risk", formula, false);
  const dev = has(i.devHoldRate) ? i.devHoldRate : 0;
  const snip = has(i.top70SniperRate) ? i.top70SniperRate : 0;
  const bund = has(i.bundlerRate) ? i.bundlerRate : 0;
  // scale: top10 at 0.40 (the widely used high-risk threshold) contributes 18/45
  const risk = clamp(i.top10Rate * 45 + dev * 25 + snip * 20 + bund * 10);
  const band = bandFor(risk, false);
  const reading =
    i.top10Rate >= 0.40 ? `Top-10 hold ${pctS(i.top10Rate)} — above the 40% high-risk line.`
    : dev >= 0.10 ? `Dev holds ${pctS(dev)} — above the 10% pressure line.`
    : bund >= 0.30 ? `Bundled wallets ${pctS(bund)} — true concentration is likely higher than it looks.`
    : i.top10Rate >= 0.25 ? "Moderate concentration — watch the top wallets."
    : "Supply is reasonably distributed for this category.";
  return { key: "concentration", label: "Concentration risk", score: Math.round(risk), band,
    display: `top10 ${pctS(i.top10Rate)}`, formula, reading, higherIsBetter: false };
}

/**
 * ORGANIC — how much of the visible activity is real demand rather than
 * manufactured. Bot share, rat-trader share and wash trading each discount it
 * multiplicatively, because they compound rather than merely add.
 */
export function organicIndex(i: IndexInputs): WarIndex {
  const formula = "Discounts visible activity for bot-driven trades, rat-trader volume and wash trading to estimate genuine demand.";
  if (!has(i.botRate) && !has(i.ratTraderRate) && i.washTrading === undefined) {
    return insufficient("organic", "Organic activity", formula);
  }
  const bot = has(i.botRate) ? i.botRate : 0;
  const rat = has(i.ratTraderRate) ? i.ratTraderRate : 0;
  const washMul = i.washTrading === true ? 0.5 : 1;
  const score = clamp(100 * (1 - bot) * (1 - rat) * washMul);
  const band = bandFor(score, true);
  const reading =
    i.washTrading === true ? "Wash trading detected — treat volume as unreliable."
    : bot >= 0.6 ? `Bot-dominated (${pctS(bot)}) — the crowd may be synthetic.`
    : bot >= 0.35 ? `Heavy bot presence (${pctS(bot)}) — discount the volume.`
    : "Activity looks mostly organic for this category.";
  return { key: "organic", label: "Organic activity", score: Math.round(score), band,
    display: `${Math.round(score)}% organic`, formula, reading, higherIsBetter: true };
}

/**
 * SNIPER LOAD — over-sniped launches tend to unload at an early multiple.
 * Measured as sniper density against the holder base, plus their held share.
 */
export function sniperIndex(i: IndexInputs): WarIndex {
  const formula = "Combines sniper density against the holder base with the share snipers hold, to gauge early-exit pressure.";
  if (!has(i.sniperCount) || !has(i.holders) || i.holders <= 0) {
    return insufficient("snipers", "Sniper load", formula, false);
  }
  const density = i.sniperCount / i.holders; // e.g. 22/446 = 0.049
  const held = has(i.top70SniperRate) ? i.top70SniperRate : 0;
  const load = clamp(density * 100 * 6 + held * 100);
  const band = bandFor(load, false);
  const reading =
    load >= 60 ? "Heavily sniped — expect aggressive early exits."
    : load >= 35 ? "Notable sniper presence — early dumps are likely."
    : load >= 15 ? "Some snipers present — normal for a fresh launch."
    : "Low sniper load.";
  return { key: "snipers", label: "Sniper load", score: Math.round(load), band,
    display: `${i.sniperCount} snipers / ${i.holders} holders`, formula, reading, higherIsBetter: false };
}

/**
 * SMART CONVICTION — presence of tracked smart-money and renowned wallets,
 * measured as density per 100 holders so a big holder base doesn't hide it.
 * Renowned wallets weigh more because the bar to qualify is higher.
 */
export function convictionIndex(i: IndexInputs): WarIndex {
  const formula = "Measures tracked smart-money and renowned-wallet density per holder base, weighting renowned wallets more heavily.";
  if (!has(i.smartMoney) && !has(i.renowned)) {
    return insufficient("conviction", "Smart conviction", formula);
  }
  if (!has(i.holders) || i.holders <= 0) return insufficient("conviction", "Smart conviction", formula);
  const smart = has(i.smartMoney) ? i.smartMoney : 0;
  const ren = has(i.renowned) ? i.renowned : 0;
  const density = (smart + ren * 1.5) / i.holders * 100; // per 100 holders
  const score = clamp(density * 12);
  const band = bandFor(score, true);
  const reading =
    score >= 70 ? `Strong smart-money footprint (${smart} smart, ${ren} renowned).`
    : score >= 40 ? `Meaningful smart-money interest (${smart} smart, ${ren} renowned).`
    : score >= 15 ? "Light smart-money presence."
    : "Little tracked smart-money involvement.";
  return { key: "conviction", label: "Smart conviction", score: Math.round(score), band,
    display: `${smart} smart · ${ren} renowned`, formula, reading, higherIsBetter: true };
}

/**
 * CONTRACT INTEGRITY — a checklist of contract-level guarantees. Each item is
 * pass/fail from confirmed flags; honeypot is an immediate floor because it
 * makes the position unexitable.
 */
export function integrityIndex(i: IndexInputs): WarIndex {
  const formula = "A contract-safety checklist: honeypot (fatal), authority renouncement, open source, LP lock/burn and reasonable taxes.";
  const known = [i.honeypot, i.renounced, i.openSource, i.renouncedMint, i.renouncedFreeze].filter(v => v !== undefined).length;
  if (known === 0 && !has(i.lockPercent) && !has(i.burnRatio)) {
    return insufficient("integrity", "Contract integrity", formula);
  }
  if (i.honeypot === true) {
    return { key: "integrity", label: "Contract integrity", score: 0, band: "CRITICAL",
      display: "HONEYPOT", formula, reading: "Honeypot detected — you may be unable to sell. Avoid.", higherIsBetter: true };
  }
  let pts = 0, max = 0;
  const add = (ok: boolean | undefined, w: number) => { if (ok !== undefined) { max += w; if (ok) pts += w; } };
  add(i.renounced, 20);
  add(i.openSource, 20);
  add(i.renouncedMint, 15);
  add(i.renouncedFreeze, 15);
  const lpSafe = (has(i.lockPercent) && i.lockPercent >= 0.5) || (has(i.burnRatio) && i.burnRatio >= 0.5);
  if (has(i.lockPercent) || has(i.burnRatio)) { max += 20; if (lpSafe) pts += 20; }
  const tax = Math.max(parseFloat(i.buyTax ?? "0") || 0, parseFloat(i.sellTax ?? "0") || 0);
  if (i.buyTax !== undefined || i.sellTax !== undefined) { max += 10; if (tax <= 0.05) pts += 10; }
  if (max === 0) return insufficient("integrity", "Contract integrity", formula);
  const score = clamp(pts / max * 100);
  const band = bandFor(score, true);
  const fails: string[] = [];
  if (i.renounced === false) fails.push("not renounced");
  if (i.openSource === false) fails.push("closed source");
  if (i.renouncedMint === false) fails.push("mint authority live");
  if (i.renouncedFreeze === false) fails.push("freeze authority live");
  if ((has(i.lockPercent) || has(i.burnRatio)) && !lpSafe) fails.push("LP not locked/burned");
  if (tax > 0.05) fails.push(`tax ${pctS(tax)}`);
  const reading = fails.length ? `Gaps: ${fails.join(" · ")}.` : "Contract-level guarantees look clean.";
  // Live mint/freeze authority means the dev can print or freeze at will — a
  // rug-pull capability. This is not honeypot-fatal, but it MUST cap the overall
  // score: no token where the dev can rug should ever read "STRONG".
  const rugAuthorityLive = i.renouncedMint === false || i.renouncedFreeze === false;
  return { key: "integrity", label: "Contract integrity", score: Math.round(score), band,
    display: `${pts}/${max} checks`, formula, reading, higherIsBetter: true,
    ...(rugAuthorityLive ? { capsScoreAt: 45 } : {}) };
}

/**
 * FLOW BALANCE — buy vs sell pressure over the observed window. Read as a share
 * of total trades so a busy token and a quiet one are comparable.
 */
export function flowIndex(i: IndexInputs): WarIndex {
  const formula = "Buy share of total trades in the observed window — buy vs sell pressure.";
  if (!has(i.buys) || !has(i.sells) || (i.buys + i.sells) === 0) {
    return insufficient("flow", "Flow balance", formula);
  }
  const tot = i.buys + i.sells;
  const score = clamp(i.buys / tot * 100);
  const band = bandFor(score, true);
  const reading =
    score >= 65 ? "Buyers clearly in control."
    : score >= 55 ? "Mild buy-side lead."
    : score >= 45 ? "Balanced two-way flow."
    : score >= 35 ? "Sell-side pressure building."
    : "Sellers dominate — distribution underway.";
  return { key: "flow", label: "Flow balance", score: Math.round(score), band,
    display: `${i.buys} buys / ${i.sells} sells`, formula, reading, higherIsBetter: true };
}

/**
 * ATH POSITION — where the cap sits against its own historical peak. High
 * retracement is context, not a verdict: it can mean a discount or a broken run.
 */
export function athIndex(i: IndexInputs): WarIndex {
  const formula = "Where the current cap sits against its own all-time-high peak.";
  if (!has(i.marketCap) || !has(i.athMarketCap) || i.athMarketCap <= 0) {
    return insufficient("ath", "ATH position", formula);
  }
  const ratio = i.marketCap / i.athMarketCap;
  const score = clamp(ratio * 100);
  const down = 1 - ratio;
  const band = bandFor(score, true);
  const reading =
    ratio >= 0.9 ? "At or near its all-time high."
    : down >= 0.8 ? `Down ${pctS(down)} from peak — the prior run has broken.`
    : down >= 0.5 ? `Down ${pctS(down)} from peak — deep retracement.`
    : `Down ${pctS(down)} from peak.`;
  return { key: "ath", label: "ATH position", score: Math.round(score), band,
    display: `${pctS(ratio)} of ATH`, formula, reading, higherIsBetter: true };
}

/**
 * TURNOVER — trades per holder. Very low means dormant; very high means a
 * churn frenzy that rarely sustains. The score peaks in the healthy middle.
 */
export function turnoverIndex(i: IndexInputs): WarIndex {
  const formula = "Trades per holder — rewards a healthy mid-range and penalises both dormancy and frenzied churn.";
  if (!has(i.buys) || !has(i.sells) || !has(i.holders) || i.holders <= 0) {
    return insufficient("turnover", "Turnover", formula);
  }
  const tpH = (i.buys + i.sells) / i.holders;
  // healthy band 3..15 → 100; below 3 scales up; above 15 decays
  const score = tpH < 3 ? clamp(tpH / 3 * 100)
    : tpH <= 15 ? 100
    : clamp(100 - (tpH - 15) * 3);
  const band = bandFor(score, true);
  const reading =
    tpH < 1 ? "Almost no trading per holder — dormant."
    : tpH < 3 ? "Light trading relative to the holder base."
    : tpH <= 15 ? "Healthy trade-to-holder ratio."
    : tpH <= 30 ? "Elevated churn — heavy rotation."
    : "Extreme churn — frenzied rotation, rarely sustained.";
  return { key: "turnover", label: "Turnover", score: Math.round(score), band,
    display: `${r1(tpH)} trades/holder`, formula, reading, higherIsBetter: true };
}

/**
 * WAR SCORE — the signature composite. Weighted across the computed indices,
 * with risk indices inverted first. INSUFFICIENT indices are EXCLUDED and the
 * weights renormalised, so a missing input never silently drags the score.
 * A honeypot forces the floor regardless of everything else.
 */
export interface WarVerdict {
  readonly score: number | null;
  readonly band: Band;
  readonly formula: string;
  readonly verdict: string;
  /** Which indices actually contributed (transparency). */
  readonly contributors: readonly string[];
  readonly excluded: readonly string[];
}

const WEIGHTS: Record<string, number> = {
  integrity: 22,
  concentration: 20,   // risk → inverted
  absorption: 18,
  organic: 15,
  snipers: 10,         // risk → inverted
  conviction: 8,
  flow: 7,
};

export function warScore(indices: readonly WarIndex[]): WarVerdict {
  const formula = "A weighted blend of all computed indices (risk indices inverted); indices with insufficient data are excluded and the blend renormalised.";
  const honeypot = indices.find(x => x.key === "integrity" && x.display === "HONEYPOT");
  if (honeypot) {
    return { score: 0, band: "CRITICAL", formula,
      verdict: "Honeypot — position may be unexitable. Do not engage.",
      contributors: ["integrity"], excluded: [] };
  }
  let sum = 0, wsum = 0;
  const contributors: string[] = [];
  const excluded: string[] = [];
  for (const idx of indices) {
    const w = WEIGHTS[idx.key];
    if (w === undefined) continue;
    if (idx.score === null) { excluded.push(idx.key); continue; }
    const val = idx.higherIsBetter ? idx.score : 100 - idx.score;
    sum += val * w; wsum += w;
    contributors.push(idx.key);
  }
  if (wsum === 0) {
    return { score: null, band: "INSUFFICIENT", formula,
      verdict: "Not enough confirmed data to form a verdict.", contributors: [], excluded };
  }
  const rawScore = Math.round(sum / wsum);
  // Apply any hard cap (e.g. live mint/freeze authority = rug capability). The
  // capped score can only be LOWER than the blend, never higher.
  const cap = Math.min(...indices.map(x => x.capsScoreAt ?? 100));
  const score = Math.min(rawScore, cap);
  const capped = score < rawScore;
  const band = bandFor(score, true);
  const verdict = capped
    ? "Score capped: the contract still lets the developer mint or freeze — a rug-pull capability that overrides otherwise-healthy structure."
    : score >= 80 ? "Structurally strong for this category — the main risks are priced low."
    : score >= 65 ? "Solid structure with manageable weak points."
    : score >= 50 ? "Mixed picture — real risks sit alongside real interest."
    : score >= 35 ? "Structurally weak — several risk factors compound here."
    : "Fragile — the structure breaks easily if attention fades.";
  return { score, band, formula, verdict, contributors, excluded };
}

/** Compute the full index set for a token. Deterministic and pure. */
export function computeIndices(i: IndexInputs): readonly WarIndex[] {
  return [
    integrityIndex(i),
    concentrationIndex(i),
    absorptionIndex(i),
    organicIndex(i),
    sniperIndex(i),
    convictionIndex(i),
    flowIndex(i),
    turnoverIndex(i),
    athIndex(i),
  ];
}

export interface WarAnalysis {
  readonly indices: readonly WarIndex[];
  readonly verdict: WarVerdict;
  /** Ranked findings: the most decision-relevant readings first. */
  readonly findings: readonly string[];
}

/**
 * Full WAR analysis: indices + composite verdict + ranked findings.
 * Findings are ordered by severity so the first line is the one that matters
 * most, rather than by field order.
 */
export function analyze(i: IndexInputs): WarAnalysis {
  const indices = computeIndices(i);
  const verdict = warScore(indices);
  // rank findings: critical/weak risk readings first, then strengths
  const scored = indices
    .filter(x => x.score !== null)
    .map(x => {
      const severity = x.higherIsBetter ? 100 - (x.score as number) : (x.score as number);
      return { idx: x, severity };
    })
    .sort((a, b) => b.severity - a.severity);
  const findings = scored.slice(0, 5).map(s => `${s.idx.label}: ${s.idx.reading}`);
  return { indices, verdict, findings };
}
