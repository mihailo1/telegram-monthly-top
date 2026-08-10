/**
 * GramJS user client (MTProto) for reading channel history + reactions.
 * On Vercel: session comes from STRING_SESSION env (no disk writes required).
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { assertUserApi, config } from "./config.js";

function loadSessionString() {
  if (config.stringSession) {
    return config.stringSession.trim();
  }
  const sessionPath = config.sessionPath;
  if (fs.existsSync(sessionPath)) {
    return fs.readFileSync(sessionPath, "utf8").trim();
  }
  return "";
}

function persistSession(client) {
  // Never write session to disk on Vercel (ephemeral + read-only project dir)
  if (config.isVercel) return;
  try {
    const sessionPath = config.sessionPath;
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, client.session.save(), "utf8");
  } catch (err) {
    console.warn("Could not persist session file:", err.message);
  }
}

/**
 * @param {{ interactive?: boolean }} [opts]
 * @returns {Promise<import('telegram').TelegramClient>}
 */
export async function getUserClient(opts = {}) {
  const { interactive = true } = opts;
  const { apiId, apiHash } = assertUserApi();

  const sessionStr = loadSessionString();
  if (!sessionStr && !interactive) {
    throw new Error(
      "No user session. Run `npm run login` locally, then set STRING_SESSION in env (Vercel).",
    );
  }

  const client = new TelegramClient(new StringSession(sessionStr), apiId, apiHash, {
    connectionRetries: 5,
    useWSS: true,
    // Avoid hanging update loop on serverless
    autoReconnect: false,
  });

  if (sessionStr) {
    await client.connect();
    if (!(await client.checkAuthorization())) {
      if (!interactive) {
        throw new Error(
          "STRING_SESSION / user.session is invalid. Re-run: npm run login",
        );
      }
      await interactiveLogin(client);
    }
  } else {
    await interactiveLogin(client);
  }

  persistSession(client);
  return client;
}

/**
 * @param {import('telegram').TelegramClient} client
 */
async function interactiveLogin(client) {
  if (!process.stdin.isTTY) {
    throw new Error(
      "Interactive login needs a TTY. Use: npm run login -- --phone +… then --code …",
    );
  }
  const rl = readline.createInterface({ input, output });
  try {
    await client.start({
      phoneNumber: async () =>
        (await rl.question("Phone (+7900…): ")).trim(),
      phoneCode: async () =>
        (await rl.question("Code from Telegram: ")).trim(),
      password: async () =>
        (await rl.question("2FA password (if any): ")).trim(),
      onError: (err) => console.error("Login error:", err.message ?? err),
    });
  } finally {
    rl.close();
  }
  console.log(
    "Logged in as",
    (await client.getMe()).username ?? "(no username)",
  );
}

export async function disconnectUserClient(client) {
  if (!client) return;
  try {
    // destroy() tears down update loops; avoids long TIMEOUT on exit
    if (typeof client.destroy === "function") {
      await client.destroy();
    } else if (client.connected) {
      await client.disconnect();
    }
  } catch (err) {
    console.warn("disconnect:", err.message ?? err);
  }
}
