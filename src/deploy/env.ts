/**
 * WAR deployment — environment configuration.
 *
 * Parses and validates process.env into a typed config once, at startup. It
 * fails loud on missing-but-required values rather than limping with undefined.
 * Secrets (bot token, api key) are read but NEVER logged or echoed. No
 * intelligence — pure configuration.
 */

export interface WarEnv {
  readonly port: number;
  readonly host: string;
  /** GMGN CLI key. Optional at boot (scans fail cleanly without it). */
  readonly gmgnApiKey: string | undefined;
  /** Telegram bot token — required only when Stars payments are enabled. */
  readonly telegramBotToken: string | undefined;
  readonly corsOrigin: string | undefined;
  readonly freeUntil: string | undefined;
  readonly requiredChannel: string | undefined;
  readonly trendingTtlHours: string | undefined;
  readonly trendingSeed: string | undefined;
  /** Postgres/Supabase connection string. When set, persistence uses Postgres
   *  (survives restarts); when unset, falls back to in-memory. */
  readonly databaseUrl: string | undefined;
  /** Shared secret for the cron-driven POST /internal/tick endpoint. */
  readonly tickSecret: string | undefined;
  /** Comma-separated Telegram user IDs with unlimited free admin access. */
  readonly adminTelegramIds: string | undefined;
  /** Solana RPC URL for Founder Wallet token discovery (public reads only). */
  readonly solanaRpcUrl: string | undefined;
  /** Founder Wallet public Solana address (for RECEIVED detection). */
  readonly founderWalletSol: string | undefined;
  /** Founder Wallet public EVM address (0x...). */
  readonly founderWalletEvm: string | undefined;
  /** Alchemy base URL for EVM discovery (contains API key). One per chain if needed. */
  readonly alchemyEthUrl: string | undefined;
  /** Node env. */
  readonly nodeEnv: "development" | "production" | "test";
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`env ${name} must be a number, got "${raw}"`);
  return n;
}

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw !== undefined && raw.trim() !== "" ? raw : fallback;
}

function optional(name: string): string | undefined {
  const raw = process.env[name];
  return raw !== undefined && raw.trim() !== "" ? raw : undefined;
}

export function loadEnv(): WarEnv {
  const nodeEnvRaw = str("NODE_ENV", "development");
  const nodeEnv =
    nodeEnvRaw === "production" || nodeEnvRaw === "test" ? nodeEnvRaw : "development";

  return {
    port: num("PORT", 8080),
    host: str("HOST", "0.0.0.0"),
    gmgnApiKey: optional("GMGN_API_KEY"),
    telegramBotToken: optional("TELEGRAM_BOT_TOKEN"),
    corsOrigin: optional("CORS_ORIGIN"),
    freeUntil: optional("FREE_UNTIL"),
    requiredChannel: optional("REQUIRED_CHANNEL"),
    trendingTtlHours: optional("TRENDING_TTL_HOURS"),
    trendingSeed: optional("TRENDING_SEED"),
    databaseUrl: optional("DATABASE_URL"),
    tickSecret: optional("TICK_SECRET"),
    adminTelegramIds: optional("ADMIN_TELEGRAM_IDS"),
    solanaRpcUrl: optional("SOLANA_RPC_URL"),
    founderWalletSol: optional("FOUNDER_WALLET_SOL"),
    founderWalletEvm: optional("FOUNDER_WALLET_EVM"),
    alchemyEthUrl: optional("ALCHEMY_ETH_URL"),
    nodeEnv,
  };
}

/** A redacted view safe to log at startup (never prints secret values). */
export function redactedEnv(env: WarEnv): Record<string, string> {
  return {
    port: String(env.port),
    host: env.host,
    nodeEnv: env.nodeEnv,
    gmgnApiKey: env.gmgnApiKey ? "set" : "unset",
    telegramBotToken: env.telegramBotToken ? "set" : "unset",
    corsOrigin: env.corsOrigin ?? "unset",
    databaseUrl: env.databaseUrl ? "set" : "unset",
  };
}
