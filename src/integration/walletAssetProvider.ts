/**
 * WAR integration — unified wallet asset discovery.
 *
 * One abstraction over "which token assets does this PUBLIC wallet hold, and
 * what recently transferred in?" with a provider per chain family:
 *   • Solana  → getTokenAccountsByOwner (RPC)
 *   • EVM     → Alchemy Token API (getTokenBalances / getAssetTransfers)
 *
 * All providers are public-address only — no private key, no signature
 * (Founder Wallet spec Rule 3). Discovery lists current token addresses; the
 * caller diffs against a snapshot to find NEW assets, then classifies.
 *
 * On EVM, a received transfer additionally carries `from` + `value` directly
 * from the ERC-20 Transfer event, so the sender is known without guessing.
 */

/** A token asset a wallet currently holds (chain-agnostic). */
export interface WalletAsset {
  readonly tokenAddress: string;   // mint (Solana) or contract (EVM)
  readonly symbol: string | null;
}

/** A detected inbound transfer (EVM providers can fill sender directly). */
export interface InboundTransfer {
  readonly tokenAddress: string;
  readonly symbol: string | null;
  readonly txHash: string;
  readonly fromAddress: string | null;
  readonly occurredAtMs: number | null;
}

export interface WalletAssetProvider {
  /** The chain this provider serves ("sol" | "bsc" | "base" | "eth"). */
  readonly chain: string;
  /** Current token assets held by a public wallet. */
  listAssets(wallet: string): Promise<readonly WalletAsset[]>;
  /**
   * Optional: recent inbound transfers for a wallet. EVM providers implement
   * this via the ERC-20 Transfer event (sender known). Solana returns null —
   * its sender/tx is resolved via GMGN holders instead. Null = "use GMGN path".
   */
  recentInbound?(wallet: string): Promise<readonly InboundTransfer[]>;
}
