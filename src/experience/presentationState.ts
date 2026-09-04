/**
 * WAR experience — presentation state resolver (Phase C / C6).
 *
 * Resolves how the HUD should present a value or a whole world, honestly:
 *   - LOADING    : data not yet arrived
 *   - READY      : a real value is present
 *   - EMPTY      : genuinely zero activity (e.g. no flow) — shown as "none", not hidden
 *   - INSUFFICIENT: gated/undefined by design — shown as INSUFFICIENT, NEVER as 0
 *   - ERROR      : acquisition failed
 *
 * CRITICAL: INSUFFICIENT and EMPTY are different. EMPTY means "we looked and there
 * was nothing" (a real zero). INSUFFICIENT means "we cannot know yet" (no number
 * exists). This resolver never collapses INSUFFICIENT into 0 or a fake estimate.
 * Pure and Node-testable; no intelligence, no data invented.
 */

import type { WorldState } from "../world/worldAdapter.js";

export type PresentationState = "LOADING" | "READY" | "EMPTY" | "INSUFFICIENT" | "ERROR";

export interface FieldPresentation {
  readonly state: PresentationState;
  /** The display value, or null when there is nothing real to show. */
  readonly value: number | null;
  /** A short honest label for the UI. */
  readonly label: string;
}

/**
 * Resolve a single force/field. `insufficientKeys` is the world's INSUFFICIENT
 * list; if `key` is in it, we return INSUFFICIENT with value=null — never 0.
 */
export function resolveField(
  key: string,
  raw: number | null | undefined,
  insufficientKeys: readonly string[],
): FieldPresentation {
  if (insufficientKeys.includes(key)) {
    return { state: "INSUFFICIENT", value: null, label: "INSUFFICIENT" };
  }
  if (raw === null || raw === undefined) {
    return { state: "INSUFFICIENT", value: null, label: "INSUFFICIENT" };
  }
  if (!Number.isFinite(raw)) {
    return { state: "ERROR", value: null, label: "ERROR" };
  }
  return { state: "READY", value: raw, label: String(raw) };
}

/**
 * Resolve the whole world's presentation state from its dataQuality + presence.
 * STALE/CONFLICTED/INSUFFICIENT quality are surfaced as-is; a world with no
 * flow and no events but COMPLETE quality is EMPTY (real quiet), not broken.
 */
export function resolveWorldState(state: WorldState): PresentationState {
  const q = state.dataQuality.toUpperCase();
  if (q === "INSUFFICIENT") return "INSUFFICIENT";
  if (q === "CONFLICTED") return "ERROR";
  const quiet = state.flowEntities.length === 0 && state.events.length === 0 && state.signals.length === 0;
  if (quiet) return "EMPTY";
  return "READY";
}

/** A LOADING placeholder for a field whose data has not arrived yet. */
export function loadingField(): FieldPresentation {
  return { state: "LOADING", value: null, label: "…" };
}

/** An ERROR placeholder (e.g. acquisition failed for this world). */
export function errorField(reason: string): FieldPresentation {
  return { state: "ERROR", value: null, label: reason };
}
