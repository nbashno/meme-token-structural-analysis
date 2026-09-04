/**
 * WAR integration — minimal Solana RPC client.
 *
 * Single purpose: list the SPL token mints held by a PUBLIC wallet address via
 * the standard `getTokenAccountsByOwner` RPC. Requires only the public address
 * and an RPC URL — NO private key, NO signature, NO wallet connection (spec
 * Rule 3). This is the Discovery layer for the Founder Wallet RECEIVED detector.
 *
 * Kept tiny and injectable (fetch is passed in for tests). It does not classify
 * anything — it only answers "which token mints does this address currently
 * hold?" GMGN then verifies whether each was received via transfer.
 */

import type { WalletAssetProvider, WalletAsset } from "./walletAssetProvider.js";

const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

export interface SolanaRpcConfig {
  readonly rpcUrl: string;
  readonly fetchImpl?: typeof fetch;
}

export class SolanaRpc implements WalletAssetProvider {
  readonly chain = "sol";
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly cfg: SolanaRpcConfig) {
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  /** Unified interface: current token assets (mints) held by the wallet. */
  async listAssets(wallet: string): Promise<readonly WalletAsset[]> {
    const mints = await this.tokenMintsOf(wallet);
    return mints.map((m) => ({ tokenAddress: m, symbol: null }));
  }

  /**
   * Return the set of token mint addresses owned by `owner` (a public address).
   * On any RPC error returns an empty array — the caller treats "no data this
   * tick" honestly rather than inventing state.
   */
  async tokenMintsOf(owner: string): Promise<readonly string[]> {
    const body = JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "getTokenAccountsByOwner",
      params: [owner, { programId: SPL_TOKEN_PROGRAM }, { encoding: "jsonParsed" }],
    });
    try {
      const res = await this.fetchImpl(this.cfg.rpcUrl, {
        method: "POST", headers: { "content-type": "application/json" }, body,
      });
      if (!res.ok) return [];
      const data = (await res.json()) as {
        result?: { value?: Array<{ account?: { data?: { parsed?: { info?: { mint?: string } } } } }> };
      };
      const rows = data.result?.value ?? [];
      const mints: string[] = [];
      for (const r of rows) {
        const mint = r.account?.data?.parsed?.info?.mint;
        if (typeof mint === "string" && mint.length > 0) mints.push(mint);
      }
      // De-duplicate (a wallet can hold the same mint in >1 account).
      return [...new Set(mints)];
    } catch {
      return [];
    }
  }
}
