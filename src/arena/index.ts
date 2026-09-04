/**
 * WAR arena layer (Phase 3) - Product surface over verified Phase 1/2 systems.
 * Read-only: projection, wiring, and honest capability status. No intelligence.
 */
export { ArenaSession, type ArenaDeps } from "./ArenaSession.js";
export { RepositorySearchPort, MonitoringHistoryReader, type ReplayHistoryEntry } from "./backends.js";
export { CAPABILITIES, capability, isUsable, type Capability, type CapabilityState } from "./capabilities.js";
export {
  NotificationDispatcher, UnavailableNotificationChannel, type NotificationChannel,
  buildShareCard, type BattleShareCard, type ShareAspect,
} from "./shareAndNotify.js";
