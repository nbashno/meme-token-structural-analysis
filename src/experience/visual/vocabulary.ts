/**
 * WAR experience — visual vocabulary (Phase A / A2).
 *
 * A pure lookup layer: it maps REAL Core values (already computed) to
 * presentational attributes (color, ring radius, bar width). It performs ZERO
 * intelligence:
 *   - it never computes power/threat/confidence/attention
 *   - it never classifies wallets or invents personas
 *   - every numeric input is a value the engine already produced
 *
 * "Tactical Minimalism": a dark neutral base, one Power accent, one Threat
 * accent, one Attention accent. Restrained. No decorative noise.
 */

import type { WorldMood } from "../../world/worldAdapter.js";

/** The restrained palette. Colors are presentational identity, not data. */
export const PALETTE = {
  base: 0x0e1116,
  panel: 0x161a21,
  line: 0x252c37,
  ink: 0xe7ecf3,
  sub: 0x8a94a6,
  power: 0x3b82f6, // the single Power accent
  threat: 0xe5484d, // the single Threat accent
  attention: 0xd6a94a, // the single Attention accent
  neutral: 0x5b6473,
} as const;

/** Mood → territory tone. Every key is a REAL Core state; none is invented. */
const MOOD_TONE: Record<WorldMood, number> = {
  UNKNOWN: PALETTE.neutral,
  OBSERVING: PALETTE.sub,
  EMERGING: 0x6fa8dc,
  ACCUMULATION: 0x4f9e8b,
  ATTACK: PALETTE.power,
  DOMINANCE: PALETTE.power,
  DISTRIBUTION: PALETTE.attention,
  BLEEDING: PALETTE.threat,
  COLLAPSE: PALETTE.threat,
  DORMANT: PALETTE.neutral,
};

export function moodTone(mood: WorldMood): number {
  return MOOD_TONE[mood];
}

/**
 * Force → bar width in 0..1. Pure normalization of an existing 0..100 value.
 * This is presentational scaling ONLY; the raw value is never altered and is
 * carried alongside it everywhere it is shown.
 */
export function forceWidth01(raw0to100: number): number {
  if (!Number.isFinite(raw0to100)) return 0;
  const clamped = Math.max(0, Math.min(100, raw0to100));
  return clamped / 100;
}

/**
 * Attention → ring radius in px, between a min and max. Presentation only.
 * Larger attention → larger ring. No thresholding that invents meaning.
 */
export function attentionRadius(raw0to100: number, min = 10, max = 34): number {
  return min + forceWidth01(raw0to100) * (max - min);
}

/** Event importance (already computed) → pulse alpha 0..1. Presentation only. */
export function eventPulseAlpha(importance0to1: number): number {
  if (!Number.isFinite(importance0to1)) return 0;
  return Math.max(0, Math.min(1, importance0to1));
}

/** Flow provenance lane → tint. Lanes are the only provenance that exists. */
export function laneTint(lane: "SMART_MONEY" | "KOL" | "FOLLOW_WALLET" | "OTHER"): number {
  switch (lane) {
    case "SMART_MONEY": return PALETTE.power;
    case "KOL": return PALETTE.attention;
    case "FOLLOW_WALLET": return PALETTE.sub;
    case "OTHER": return PALETTE.neutral;
  }
}
