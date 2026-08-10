import "dotenv/config";
import path from "node:path";

function required(name, { optional = false } = {}) {
  const value = process.env[name]?.trim();
  if (!value && !optional) {
    throw new Error(
      `Missing env ${name}. Copy .env.example → .env and fill values.`,
    );
  }
  return value || "";
}

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`Env ${name} must be a number, got: ${raw}`);
  }
  return n;
}

const isVercel = Boolean(process.env.VERCEL);

export const config = {
  isVercel,
  botToken: required("BOT_TOKEN", { optional: true }),
  adminId: required("ADMIN_ID", { optional: true }),
  groupChatId: required("GROUP_CHAT_ID", { optional: true }),
  channelUsername: (
    process.env.CHANNEL_USERNAME || "krasiviyded"
  ).replace(/^@/, ""),
  // APP_TZ preferred: Vercel reserves the name TZ
  timeZone: process.env.APP_TZ || process.env.TZ || "Europe/Moscow",
  topBase: intEnv("TOP_BASE", 5),
  topMax: intEnv("TOP_MAX", 10),
  apiId: intEnv("API_ID", 0),
  apiHash: required("API_HASH", { optional: true }),
  /** Preferred on Vercel (no disk). From data/user.session after npm run login */
  stringSession: required("STRING_SESSION", { optional: true }),
  sessionPath: path.resolve(
    process.env.SESSION_PATH || "./data/user.session",
  ),
  /** Protects /api/cron and /api/preview */
  cronSecret: required("CRON_SECRET", { optional: true }),
  /** Optional extra secret checked on webhook URL ?secret= */
  webhookSecret: required("WEBHOOK_SECRET", { optional: true }),
  /** Public site URL, e.g. https://xxx.vercel.app (no trailing slash) */
  publicUrl: (() => {
    const raw = (process.env.PUBLIC_URL || "").trim().replace(/\/$/, "");
    if (raw) return raw.startsWith("http") ? raw : `https://${raw}`;
    if (process.env.VERCEL_URL) {
      return `https://${process.env.VERCEL_URL.replace(/\/$/, "")}`;
    }
    return "";
  })(),
};

export function assertBotToken() {
  if (!config.botToken) {
    throw new Error("BOT_TOKEN is required. Get it from @BotFather.");
  }
  return config.botToken;
}

export function assertAdminId() {
  if (!config.adminId) {
    throw new Error(
      "ADMIN_ID is required. Message the bot with /start and set ADMIN_ID.",
    );
  }
  return config.adminId;
}

export function assertUserApi() {
  if (!config.apiId || !config.apiHash) {
    throw new Error(
      "API_ID and API_HASH are required. Get them at https://my.telegram.org/apps",
    );
  }
  return { apiId: config.apiId, apiHash: config.apiHash };
}

export function assertPublicUrl() {
  let url = config.publicUrl;
  if (!url && process.env.VERCEL_URL) {
    url = `https://${process.env.VERCEL_URL}`;
  }
  if (!url) {
    throw new Error("PUBLIC_URL or VERCEL_URL is required to set webhook.");
  }
  return url.replace(/\/$/, "");
}
