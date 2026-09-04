/**
 * WAR experience — Radar bridge (Phase B / B7).
 *
 * The tactical radar reuses the EXISTING Phase 2 radar projection
 * (toRadarBlip, radarOrder) unchanged. It orders worlds by a SINGLE existing
 * field (power / threat / attention / confidence) — never a composite score.
 * This bridge only gathers the live WorldStates from the engine and hands them
 * to the existing pure functions. Zero new intelligence.
 */

import type { WorldEngine } from "../world/worldEngine.js";
import { toRadarBlip, radarOrder, type RadarBlip, type RadarSortField } from "../world/worldRadar.js";

/** Collect blips for every mounted instance that has a state, ordered by `by`. */
export function radarBlips(engine: WorldEngine, ids: readonly string[], by: RadarSortField): readonly RadarBlip[] {
  const blips: RadarBlip[] = [];
  for (const id of ids) {
    const inst = engine.get(id);
    if (inst?.state) blips.push(toRadarBlip(inst.state));
  }
  return radarOrder(blips, by);
}

export type { RadarBlip, RadarSortField };
