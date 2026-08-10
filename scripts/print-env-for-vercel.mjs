/**
 * Prints non-secret keys + lengths of secrets for Vercel dashboard checklist.
 * Does NOT print secret values.
 */
import "dotenv/config";
import fs from "node:fs";

const keys = [
  "BOT_TOKEN",
  "ADMIN_ID",
  "GROUP_CHAT_ID",
  "CHANNEL_USERNAME",
  "TZ",
  "TOP_BASE",
  "TOP_MAX",
  "API_ID",
  "API_HASH",
  "STRING_SESSION",
  "CRON_SECRET",
  "WEBHOOK_SECRET",
  "PUBLIC_URL",
  "BLOB_READ_WRITE_TOKEN",
];

console.log("Vercel env checklist (values hidden):\n");
for (const k of keys) {
  let v = process.env[k] || "";
  if (k === "STRING_SESSION" && !v && fs.existsSync("data/user.session")) {
    v = fs.readFileSync("data/user.session", "utf8").trim();
  }
  if (!v) {
    console.log(`  ${k}=  (MISSING)`);
  } else if (
    /TOKEN|SECRET|HASH|SESSION|PASSWORD/i.test(k)
  ) {
    console.log(`  ${k}=  set (len=${v.length})`);
  } else {
    console.log(`  ${k}=  ${v}`);
  }
}

if (!process.env.CRON_SECRET) {
  console.log("\nTip: generate CRON_SECRET:");
  console.log("  openssl rand -hex 16");
}
