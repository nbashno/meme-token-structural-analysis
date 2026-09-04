/**
 * WAR integration - Scan composition root (Phase 5C).
 *
 * Wires the REAL ports into ScanService for the production path:
 *
 *   ScanService
 *     .acquisition = RealGmgnAcquisitionPort  (CLI -> parser -> normalizer)
 *     .evaluation  = RealWarEvaluationPort     (-> evaluateToBattlefield)
 *
 * There is NO test seam here. The only injected dependency that varies between
 * production and test is the CliExecutor (real gmgn-cli vs. a raw-payload stub) —
 * everything downstream of it is the real chain. ScanService itself is unchanged.
 */

import type { CliExecutor } from "../adapters/gmgn/gmgnRunner.js";
import type { ModelVersions } from "../shared/quality.js";
import type { Clock } from "../product/domain/identity.js";
import type { UnitOfWork } from "../product/persistence/contracts/repositories.js";
import type { EntitlementLedger } from "../product/payment/entitlement.js";
import { ScanService } from "../product/scan/orchestration/scanService.js";
import { RealGmgnAcquisitionPort, type AcquisitionConfig, DEFAULT_ACQUISITION_CONFIG } from "./RealGmgnAcquisitionPort.js";
import { RealWarEvaluationPort, type DiagnosticsSink } from "./RealWarEvaluationPort.js";

export interface ScanCompositionDeps {
  readonly uow: UnitOfWork;
  readonly clock: Clock;
  readonly entitlements: EntitlementLedger;
  readonly engineVersion: string;
  readonly modelVersions: ModelVersions;
  /** The only prod/test-varying dependency: real gmgn-cli or a raw-payload stub. */
  readonly cliExecutor: CliExecutor;
  readonly acquisitionConfig?: AcquisitionConfig;
  readonly diagnostics?: DiagnosticsSink;
}

/**
 * Build a production ScanService wired to the real acquisition + evaluation
 * ports. Injecting a real CliExecutor makes this a fully live scan pipeline;
 * injecting a stub CliExecutor tests the whole chain minus the network.
 */
export function createScanService(deps: ScanCompositionDeps): ScanService {
  const acquisition = new RealGmgnAcquisitionPort(
    deps.cliExecutor,
    deps.acquisitionConfig ?? DEFAULT_ACQUISITION_CONFIG,
  );
  const evaluation = new RealWarEvaluationPort(deps.diagnostics);

  return new ScanService({
    uow: deps.uow,
    acquisition,
    evaluation,
    clock: deps.clock,
    entitlements: deps.entitlements,
    engineVersion: deps.engineVersion,
    modelVersions: deps.modelVersions,
  });
}
