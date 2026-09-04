/**
 * WAR integration - RealWarEvaluationPort (Phase 5B).
 *
 * The composition-root adapter that satisfies the product-side WarEvaluationPort
 * by delegating to the REAL core evaluator evaluateToBattlefield. It contains NO
 * intelligence of its own. The only transformations are structural:
 *
 *   - atMs                     -> EvaluationObservations.evaluationAt
 *   - EvaluationOutput.battlefield -> BattlefieldState (unwrap)
 *   - EvaluationOutput.diagnostics -> recorded, NEVER a product decision input
 *   - sync                     -> Promise (the port is async)
 *
 * This layer may import both product contracts and core; it is the wiring seam.
 * It does not touch POWER/THREAT/CONFIDENCE config or any factor. It cannot
 * inject power/threat/battlefield — those come only from the core chain.
 */

import type { Chain, TokenAddress } from "../shared/scalars.js";
import type { UnixMillis } from "../shared/scalars.js";
import type { BattlefieldState } from "../core/battlefield/types.js";
import { evaluateToBattlefield } from "../core/features/warEvaluation.js";
import type { WarEvaluationPort, NormalizedObservations } from "../product/scan/ports/ports.js";
import type { DomainResult } from "../product/domain/identity.js";
import { ok, err } from "../product/domain/identity.js";

/** Optional sink for diagnostics; observing only, never feeds product decisions. */
export interface DiagnosticsSink {
  record(insufficient: readonly string[]): void;
}

export class RealWarEvaluationPort implements WarEvaluationPort {
  constructor(private readonly diagnostics?: DiagnosticsSink) {}

  async evaluate(
    observations: NormalizedObservations,
    atMs: number,
  ): Promise<DomainResult<BattlefieldState>> {
    try {
      const output = evaluateToBattlefield({
        chain: observations.chain as Chain,
        address: observations.address as TokenAddress,
        market: observations.market,
        analytics: observations.analytics,
        flow: observations.flow,
        // Structural mapping only: the evaluation instant is atMs.
        evaluationAt: atMs as UnixMillis,
      });

      // Diagnostics are recorded for auditability, never used to alter the result.
      if (this.diagnostics) this.diagnostics.record(output.diagnostics.insufficient);

      return ok(output.battlefield);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return err(`evaluation failed: ${reason}`);
    }
  }
}
