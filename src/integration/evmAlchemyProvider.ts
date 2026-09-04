/**
 * WAR integration — EVM wallet asset provider (Alchemy Token API).
 *
 * Public-address only (no private key). Serves ETH / BSC / Base via Alchemy's
 * multichain Token API:
 *   • listAssets     → alchemy_getTokenBalances (which ERC-20s the wallet holds)
 *   • recentInbound  → alchemy_getAssetTransfers (inbound ERC-20 transfers,
 *                      each carrying `from`, `value`, `hash` from the Transfer
 *                      event — so the sender is KNOWN, not guessed)
 *
 * One Alchemy app serves all EVM chains via per-chain base URLs; the caller
 * passes the right rpcUrl per chain. Field names are read defensively and any
 * missing field stays null (never invented).
 */

import type { WalletAssetProvider, WalletAsset, InboundTransfer } from "./walletAssetProvider.js";

export interface EvmAlchemyConfig {
  readonly chain: string;      // "eth" | "bsc" | "base"
  readonly rpcUrl: string;     // Alchemy per-chain URL (contains the API key)
  readonly fetchImpl?: typeof fetch;
}

export class EvmAlchemyProvider implements WalletAssetProvider {
  readonly chain: string;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly cfg: EvmAlchemyConfig) {
    this.chain = cfg.chain;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T | null> {
    try {
      const res = await this.fetchImpl(this.cfg.rpcUrl, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { result?: T };
      return data.result ?? null;
    } catch {
      return null;
    }
  }

  /** Discovery: ERC-20 contracts the wallet currently holds (non-zero). */
  async listAssets(wallet: string): Promise<readonly WalletAsset[]> {
    const r = await this.rpc<{ tokenBalances?: Array<{ contractAddress?: string; tokenBalance?: string }> }>(
      "alchemy_getTokenBalances", [wallet, "erc20"],
    );
    const rows = r?.tokenBalances ?? [];
    const out: WalletAsset[] = [];
    for (const row of rows) {
      const addr = row.contractAddress;
      // Skip zero balances (hex "0x0..." or "0x").
      const bal = row.tokenBalance ?? "0x0";
      const nonZero = /[1-9a-f]/i.test(bal.replace(/^0x0*/, ""));
      if (typeof addr === "string" && addr.length > 0 && nonZero) {
        out.push({ tokenAddress: addr, symbol: null });
      }
    }
    return out;
  }

  /**
   * Recent inbound ERC-20 transfers TO this wallet. Each carries the sender and
   * tx hash directly from the Transfer event — no GMGN needed for EVM.
   */
  async recentInbound(wallet: string): Promise<readonly InboundTransfer[]> {
    const r = await this.rpc<{ transfers?: Array<Record<string, unknown>> }>(
      "alchemy_getAssetTransfers",
      [{
        toAddress: wallet,
        category: ["erc20"],
        order: "desc",
        maxCount: "0x14", // 20
        withMetadata: true,
      }],
    );
    const rows = r?.transfers ?? [];
    const out: InboundTransfer[] = [];
    for (const t of rows) {
      const rawContract = (typeof t["rawContract"] === "object" && t["rawContract"]) ? t["rawContract"] as Record<string, unknown> : {};
      const tokenAddress = typeof rawContract["address"] === "string" ? rawContract["address"] : "";
      const txHash = typeof t["hash"] === "string" ? t["hash"] : "";
      if (!tokenAddress || !txHash) continue; // require identity; never fabricate
      const from = typeof t["from"] === "string" && t["from"] ? t["from"] : null;
      const symbol = typeof t["asset"] === "string" && t["asset"] ? t["asset"] : null;
      const meta = (typeof t["metadata"] === "object" && t["metadata"]) ? t["metadata"] as Record<string, unknown> : {};
      const blockTs = typeof meta["blockTimestamp"] === "string" ? Date.parse(meta["blockTimestamp"]) : NaN;
      out.push({
        tokenAddress, symbol, txHash, fromAddress: from,
        occurredAtMs: Number.isFinite(blockTs) ? blockTs : null,
      });
    }
    return out;
  }
}
