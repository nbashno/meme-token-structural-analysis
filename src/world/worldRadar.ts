/**
 * WAR world - Search contract + WAR Radar projection (Phase 2).
 *
 * Search: no search backend exists in Phase 1 contracts. We define the query +
 * result CONTRACT and a UI can bind to it, but there is no data service to invent.
 * Status: SEARCH = BLOCKED_BY_SEARCH_CONTRACT. No fake results are produced.
 *
 * Radar: a projection of EXISTING per-world values. It never computes a composite
 * score (no `power*confidence`); it can only order by a field that already exists.
 */

import type { WorldState } from "./worldAdapter.js";

// ── Search contract (backend PENDING) ────────────────────────────────────────

export interface SearchQuery {
  readonly text: string; // symbol, name, or address
}

export interface SearchResult {
  readonly chain: string;
  readonly address: string;
  readonly symbol: string | null;
}

/** The port a real search backend must implement. None exists yet in Phase 1. */
export interface SearchPort {
  search(query: SearchQuery): Promise<readonly SearchResult[]>;
}

/** Explicit stand-in that refuses to fabricate results. */
export class UnavailableSearchPort implements SearchPort {
  async search(_query: SearchQuery): Promise<readonly SearchResult[]> {
    // No contract to serve. Returns empty; caller shows "search backend pending".
    return [];
  }
}

// ── WAR Radar (projection only) ──────────────────────────────────────────────

/** Fields the radar may order by — each ALREADY EXISTS on WorldState. No composites. */
export type RadarSortField = "power" | "threat" | "attention" | "confidence";

export interface RadarBlip {
  readonly id: string;
  readonly mood: string;
  readonly power: number;
  readonly threat: number;
  readonly attention: number;
  readonly confidence: number;
  readonly eventCount: number;
  readonly signalCount: number;
}

export function toRadarBlip(state: WorldState): RadarBlip {
  return {
    id: `${state.chain}:${state.address}`,
    mood: state.mood,
    power: state.power.raw,
    threat: state.threat.raw,
    attention: state.attention.raw,
    confidence: state.confidence.raw,
    eventCount: state.events.length,
    signalCount: state.signals.length,
  };
}

/** Order blips by a SINGLE existing field (descending). No composite ranking. */
export function radarOrder(blips: readonly RadarBlip[], by: RadarSortField): readonly RadarBlip[] {
  return [...blips].sort((a, b) => b[by] - a[by]);
}
