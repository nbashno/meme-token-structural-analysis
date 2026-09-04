/**
 * WAR core - State Machine (Phase 9).
 *
 * Deterministic market lifecycle. NO single-condition jumps: a transition fires
 * only when SEVERAL signals agree (power + coherence + persistence + confidence
 * + threat), and only after minimum dwell. Every transition records its reasons.
 *
 * Time is injected. Pure, total, deterministic. No clock, no randomness, no IO.
 */

import type { UnixMillis } from "../../shared/scalars.js";
import type { MarketState, StateTransition } from "./types.js";
import type { TrajectoryClass } from "../temporal/types.js";
import type { StateMachineConfig } from "../../config/stateMachine.js";
import { STATE_MACHINE_CONFIG } from "../../config/stateMachine.js";

/** The evidence a transition decision is made from at a given instant. */
export interface StateInputs {
  readonly now: UnixMillis;
  readonly power: number; // 0..100
  readonly threat: number; // 0..100
  readonly confidence: number; // 0..100
  readonly netCoherence: number; // 0..1
  readonly persistence: number; // 0..1
  readonly trajectory: TrajectoryClass;
}

/** Current machine position: the state and when it was entered. */
export interface StateContext {
  readonly state: MarketState;
  readonly enteredAt: UnixMillis;
}

export interface StateDecision {
  readonly context: StateContext;
  readonly transition: StateTransition | null;
}

const UP_TRAJECTORIES: ReadonlySet<TrajectoryClass> = new Set([
  "ACCELERATING_UP",
  "RISING",
]);
const DOWN_TRAJECTORIES: ReadonlySet<TrajectoryClass> = new Set([
  "FALLING",
  "ACCELERATING_DOWN",
]);

/** Does the evidence justify entering `target`? Returns reasons or null. */
function entryReasons(
  target: MarketState,
  i: StateInputs,
  c: StateMachineConfig,
): string[] | null {
  const up = UP_TRAJECTORIES.has(i.trajectory);
  const down = DOWN_TRAJECTORIES.has(i.trajectory);
  const coherent = i.netCoherence >= c.coherenceMin;
  const persistent = i.persistence >= c.persistenceMin;
  const confident = i.confidence >= c.confidenceFloor;
  const reasons: string[] = [];

  switch (target) {
    case "BLEEDING": {
      if (i.threat >= c.threatHigh && down) {
        reasons.push(`threat ${i.threat} >= ${c.threatHigh}`, "downward trajectory");
        return reasons;
      }
      return null;
    }
    case "COLLAPSE": {
      if (i.threat >= c.threatHigh && i.trajectory === "ACCELERATING_DOWN" && persistent) {
        reasons.push(`threat ${i.threat} high`, "accelerating down", "persistent");
        return reasons;
      }
      return null;
    }
    case "DOMINANCE": {
      if (i.power >= c.powerDominance && coherent && confident && up) {
        reasons.push(
          `power ${i.power} >= ${c.powerDominance}`,
          "coherent",
          "confident",
          "upward trajectory",
        );
        return reasons;
      }
      return null;
    }
    case "ATTACK": {
      if (i.power >= c.powerAttack && coherent && persistent && confident && up) {
        reasons.push(
          `power ${i.power} >= ${c.powerAttack}`,
          "coherent",
          "persistent",
          "confident",
          "upward trajectory",
        );
        return reasons;
      }
      return null;
    }
    case "ACCUMULATION": {
      if (i.power >= c.powerAccumulation && coherent && confident && !down) {
        reasons.push(
          `power ${i.power} >= ${c.powerAccumulation}`,
          "coherent",
          "confident",
          "not falling",
        );
        return reasons;
      }
      return null;
    }
    case "DISTRIBUTION": {
      // strength present but flow/vectors turning: high-ish power, weak coherence, some threat
      if (i.power >= c.powerAccumulation && i.netCoherence < c.coherenceMin && i.threat > 0) {
        reasons.push(
          `power ${i.power} still elevated`,
          `coherence ${i.netCoherence.toFixed(2)} weakening`,
          `threat present ${i.threat}`,
        );
        return reasons;
      }
      return null;
    }
    case "EMERGING": {
      if (i.power >= c.powerEmerging && confident) {
        reasons.push(`power ${i.power} >= ${c.powerEmerging}`, "confident");
        return reasons;
      }
      return null;
    }
    case "OBSERVING": {
      reasons.push("baseline observation");
      return reasons;
    }
    default:
      return null;
  }
}

/**
 * Priority order for evaluating candidate target states. Danger states are
 * checked first so high threat cannot be masked by strength.
 */
const EVALUATION_ORDER: readonly MarketState[] = [
  "COLLAPSE",
  "BLEEDING",
  "DISTRIBUTION",
  "DOMINANCE",
  "ATTACK",
  "ACCUMULATION",
  "EMERGING",
  "OBSERVING",
];

/**
 * Advance the state machine by one step. Enforces minimum dwell (unless a
 * danger state supersedes) and records reasons on any transition.
 */
export function stepStateMachine(
  ctx: StateContext,
  inputs: StateInputs,
  config: StateMachineConfig = STATE_MACHINE_CONFIG,
): StateDecision {
  const dwell = (inputs.now as number) - (ctx.enteredAt as number);
  const dwellSatisfied = dwell >= config.minDwellMs;

  // Danger states may supersede dwell (a collapsing token must not be held).
  for (const target of EVALUATION_ORDER) {
    if (target === ctx.state) continue;

    const isDanger = target === "COLLAPSE" || target === "BLEEDING";
    if (!dwellSatisfied && !isDanger) continue;

    const reasons = entryReasons(target, inputs, config);
    if (reasons === null) continue;

    const transition: StateTransition = {
      from: ctx.state,
      to: target,
      at: inputs.now,
      reasons,
      hysteresisSatisfied: dwellSatisfied,
    };
    return {
      context: { state: target, enteredAt: inputs.now },
      transition,
    };
  }

  // No transition: hold current state.
  return { context: ctx, transition: null };
}

/** Convenience: the canonical starting context. */
export function initialStateContext(at: UnixMillis): StateContext {
  return { state: "OBSERVING", enteredAt: at };
}
