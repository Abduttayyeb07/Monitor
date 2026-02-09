import dotenv from "dotenv";

dotenv.config();

export interface AppConfig {
  wsUrl: string;
  lcdUrl: string;
  telegramToken: string;
  telegramChatId: string | null;
  monitoredWallets: Set<string>;
  minAmountUzig: bigint;
  zigDecimals: bigint;
  maxSeenTxHashes: number;
}

const MONITORED_WALLETS = [
  "zig1l9l6ztayaeservh407jgy5t0ek32rva5edsajn",
  "zig1r3wdrz2ufjcf80fekd7eeu434c238aekkzemst",
  "zig1zm00h4n9vsfs6m5ld9ha2nwnqkt4gn8v3fe46q"
];

const DEFAULT_WS_URL = "wss://zigchain-mainnet.zigscan.net/websocket";
const DEFAULT_LCD_URL = "https://public-zigchain-lcd.numia.xyz";
const ZIG_DECIMALS = 1_000_000n;

function requireEnv(name: "TELEGRAM_BOT_TOKEN"): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function optionalEnv(name: "TELEGRAM_CHAT_ID"): string | null {
  const value = process.env[name]?.trim();
  return value || null;
}

function normalizeWsUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (trimmed === "wss://zigchain-mainnet.zigscan.net/ws") {
    console.warn("[config] WS_URL /ws is invalid on this host. Using /websocket instead.");
    return "wss://zigchain-mainnet.zigscan.net/websocket";
  }

  return trimmed;
}

function parseMinAmountZig(): bigint {
  const raw = process.env.MIN_AMOUNT_ZIG?.trim();
  if (!raw) {
    return 50_000n;
  }

  if (!/^\d+$/.test(raw)) {
    throw new Error("MIN_AMOUNT_ZIG must be an integer string, e.g. 1 or 50000");
  }

  return BigInt(raw);
}

const MIN_AMOUNT_UZIG = parseMinAmountZig() * ZIG_DECIMALS;

export const config: AppConfig = {
  wsUrl: normalizeWsUrl(process.env.WS_URL || DEFAULT_WS_URL),
  lcdUrl: process.env.LCD_URL?.trim() || DEFAULT_LCD_URL,
  telegramToken: requireEnv("TELEGRAM_BOT_TOKEN"),
  telegramChatId: optionalEnv("TELEGRAM_CHAT_ID"),
  monitoredWallets: new Set(MONITORED_WALLETS),
  minAmountUzig: MIN_AMOUNT_UZIG,
  zigDecimals: ZIG_DECIMALS,
  maxSeenTxHashes: 10_000
};
