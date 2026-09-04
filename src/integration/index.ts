/**
 * WAR integration layer - composition root wiring.
 *
 * This layer connects existing contracts (core evaluator + gmgn adapter + product
 * ports) without adding intelligence. It is the ONLY place allowed to import both
 * core and adapters, because its job is wiring, not logic.
 */
export { RealWarEvaluationPort, type DiagnosticsSink } from "./RealWarEvaluationPort.js";
export {
  RealGmgnAcquisitionPort,
  DEFAULT_ACQUISITION_CONFIG,
  type AcquisitionConfig,
} from "./RealGmgnAcquisitionPort.js";
export { createScanService, type ScanCompositionDeps } from "./scanComposition.js";
export { MonitoringService, type MonitorServiceDeps, type MonitorTickOutcome } from "./MonitoringService.js";
export { monitorTick, initialCarry, type MonitorCarry, type MonitorTickResult } from "./monitorTick.js";
export * from "./GmgnCliExecutor.js";
export * from "./warRuntime.js";
