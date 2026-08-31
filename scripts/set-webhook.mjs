/**
 * Local helper: point Telegram webhook at PUBLIC_URL/api/webhook
 * Usage: PUBLIC_URL=https://xxx.vercel.app npm run set-webhook
 */
import "dotenv/config";
import { Bot } from "grammy";

const token = process.env.BOT_TOKEN;
const base = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
const webhookSecret = process.env.WEBHOOK_SECRET || "";

if (!token) {
  console.error("BOT_TOKEN required");
  process.exit(1);
}
if (!base) {
  console.error("PUBLIC_URL required, e.g. https://your-app.vercel.app");
  process.exit(1);
}

let url = `${base}/api/webhook`;
if (webhookSecret) url += `?secret=${encodeURIComponent(webhookSecret)}`;

const bot = new Bot(token);
await bot.api.setWebhook(url, {
  drop_pending_updates: true,
  allowed_updates: ["message", "callback_query", "poll"],
});
const info = await bot.api.getWebhookInfo();
console.log("Webhook set:", url);
console.log(JSON.stringify(info, null, 2));
