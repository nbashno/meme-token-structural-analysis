/**
 * WAR arena - Notifications + Share cards (Phase 3.7 + 3.19).
 *
 * Notifications: AlertRepository stores alerts, but no delivery CHANNEL contract
 * exists (no email/push/webhook infra in Phase 1). We define the dispatcher
 * contract and a null channel that is explicitly NOT_IMPLEMENTED rather than
 * pretending delivery works.
 *
 * Share cards: a deterministic projection of a WorldState into a shareable
 * representation. Every value comes straight from the state — no hidden calc.
 */

import type { WorldState } from "../world/worldAdapter.js";
import type { AlertRow } from "../product/persistence/contracts/repositories.js";

// ── Notifications ─────────────────────────────────────────────────────────────

/** A delivery channel. None is implemented; the contract is defined for later. */
export interface NotificationChannel {
  readonly name: string;
  readonly available: boolean;
  deliver(alert: AlertRow): Promise<{ delivered: boolean; reason: string }>;
}

/** Explicit null channel: stores exist, delivery does not. Never fakes success. */
export class UnavailableNotificationChannel implements NotificationChannel {
  readonly name = "none";
  readonly available = false;
  async deliver(): Promise<{ delivered: boolean; reason: string }> {
    return { delivered: false, reason: "NOTIFICATION_DELIVERY_NOT_IMPLEMENTED" };
  }
}

export class NotificationDispatcher {
  constructor(private readonly channel: NotificationChannel = new UnavailableNotificationChannel()) {}
  async dispatch(alert: AlertRow): Promise<{ delivered: boolean; reason: string }> {
    if (!this.channel.available) return { delivered: false, reason: "NOTIFICATION_DELIVERY_NOT_IMPLEMENTED" };
    return this.channel.deliver(alert);
  }
}

// ── Share cards ───────────────────────────────────────────────────────────────

export type ShareAspect = "1:1" | "16:9" | "9:16";

/** A share card is pure projection — every field is copied from WorldState. */
export interface BattleShareCard {
  readonly token: string;
  readonly chain: string;
  readonly state: string;
  readonly power: number;
  readonly threat: number;
  readonly confidence: number;
  readonly attention: number;
  readonly trajectory: string;
  readonly topEvent: string | null;
  readonly timestamp: number;
  readonly dataQuality: string;
  readonly insufficient: readonly string[];
  readonly aspect: ShareAspect;
  readonly disclaimer: string;
}

const DISCLAIMER = "WAR ARENA presents engine output only. Not financial advice; no token performance is guaranteed.";

/** Build a share card from a world state. Deterministic, no computation. */
export function buildShareCard(state: WorldState, aspect: ShareAspect = "1:1"): BattleShareCard {
  return {
    token: state.address,
    chain: state.chain,
    state: state.mood,
    power: state.power.raw,
    threat: state.threat.raw,
    confidence: state.confidence.raw,
    attention: state.attention.raw,
    trajectory: state.trajectory,
    topEvent: state.events[0]?.type ?? null,
    timestamp: state.generatedAt,
    dataQuality: state.dataQuality,
    insufficient: state.insufficient,
    aspect,
    disclaimer: DISCLAIMER,
  };
}
