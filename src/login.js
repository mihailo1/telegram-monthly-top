/**
 * User MTProto login (works without an interactive TTY).
 *
 * Two-step flow (recommended when run via agent):
 *
 *   npm run login -- --phone +79001234567
 *   # check Telegram for the code, then:
 *   npm run login -- --code 12345
 *   # if 2FA is on:
 *   npm run login -- --code 12345 --password 'your-2fa'
 *
 * One-shot if you already have the code from a previous send (rare):
 *   npm run login -- --phone +79… --code 12345
 *
 * Session → SESSION_PATH (default ./data/user.session)
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Api } from "telegram/tl/index.js";
import { assertUserApi, config } from "./config.js";

const PENDING_PATH = path.resolve("./data/login-pending.json");

function parseArgs(argv) {
  const out = { phone: "", code: "", password: "", help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--phone" || a === "-p") out.phone = argv[++i] || "";
    else if (a === "--code" || a === "-c") out.code = argv[++i] || "";
    else if (a === "--password" || a === "--2fa") out.password = argv[++i] || "";
    else if (a.startsWith("+") && !out.phone) out.phone = a;
    else if (/^\d{4,8}$/.test(a) && !out.code) out.code = a;
  }
  // Env fallbacks
  out.phone = out.phone || process.env.TG_PHONE || "";
  out.code = out.code || process.env.TG_CODE || "";
  out.password = out.password || process.env.TG_PASSWORD || "";
  return out;
}

function printHelp() {
  console.log(`Usage:
  npm run login -- --phone +79001234567
  npm run login -- --code 12345
  npm run login -- --code 12345 --password '2fa-password'

Env alternatives: TG_PHONE, TG_CODE, TG_PASSWORD`);
}

function loadSessionString() {
  const sessionPath = config.sessionPath;
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  if (fs.existsSync(sessionPath)) {
    return fs.readFileSync(sessionPath, "utf8").trim();
  }
  return "";
}

function saveSession(client) {
  fs.writeFileSync(config.sessionPath, client.session.save(), "utf8");
}

function savePending(data) {
  fs.mkdirSync(path.dirname(PENDING_PATH), { recursive: true });
  fs.writeFileSync(PENDING_PATH, JSON.stringify(data, null, 2), "utf8");
}

function loadPending() {
  if (!fs.existsSync(PENDING_PATH)) return null;
  return JSON.parse(fs.readFileSync(PENDING_PATH, "utf8"));
}

function clearPending() {
  if (fs.existsSync(PENDING_PATH)) fs.unlinkSync(PENDING_PATH);
}

async function createClient() {
  const { apiId, apiHash } = assertUserApi();
  const client = new TelegramClient(
    new StringSession(loadSessionString()),
    apiId,
    apiHash,
    { connectionRetries: 5, useWSS: true },
  );
  await client.connect();
  return client;
}

async function finishOk(client) {
  saveSession(client);
  clearPending();
  const me = await client.getMe();
  console.log("");
  console.log("OK — logged in as:");
  console.log(`  id: ${me.id}`);
  console.log(`  username: @${me.username || "(none)"}`);
  console.log(`  name: ${[me.firstName, me.lastName].filter(Boolean).join(" ")}`);
  console.log(`  session saved: ${config.sessionPath}`);
  console.log("");
  console.log("Next: npm run preview-month");
  await client.disconnect();
}

/**
 * Step 1: send login code to the phone.
 */
async function sendCode(phone) {
  const client = await createClient();
  if (await client.checkAuthorization()) {
    console.log("Already logged in.");
    await finishOk(client);
    return;
  }

  const normalized = phone.replace(/\s+/g, "");
  console.log(`Sending code to ${normalized}…`);
  const { apiId, apiHash } = assertUserApi();
  const result = await client.invoke(
    new Api.auth.SendCode({
      phoneNumber: normalized,
      apiId,
      apiHash,
      settings: new Api.CodeSettings({}),
    }),
  );

  const phoneCodeHash = result.phoneCodeHash;
  savePending({
    phone: normalized,
    phoneCodeHash,
    createdAt: new Date().toISOString(),
  });
  saveSession(client); // keep DC/auth key progress
  await client.disconnect();

  console.log("");
  console.log("Code sent. Check Telegram (or SMS).");
  console.log("Then run:");
  console.log(`  npm run login -- --code YOUR_CODE`);
  console.log("If 2FA is enabled:");
  console.log(`  npm run login -- --code YOUR_CODE --password 'YOUR_2FA'`);
}

/**
 * Step 2: sign in with code (+ optional 2FA).
 */
async function signInWithCode(code, password) {
  const pending = loadPending();
  if (!pending?.phone || !pending?.phoneCodeHash) {
    throw new Error(
      "No pending login. Run first:\n  npm run login -- --phone +79001234567",
    );
  }

  const client = await createClient();
  if (await client.checkAuthorization()) {
    console.log("Already logged in.");
    await finishOk(client);
    return;
  }

  try {
    await client.invoke(
      new Api.auth.SignIn({
        phoneNumber: pending.phone,
        phoneCodeHash: pending.phoneCodeHash,
        phoneCode: String(code).trim(),
      }),
    );
  } catch (err) {
    const msg = String(err.errorMessage || err.message || err);
    if (msg.includes("SESSION_PASSWORD_NEEDED")) {
      if (!password) {
        await client.disconnect();
        throw new Error(
          "2FA password required. Run:\n" +
            "  npm run login -- --code " +
            code +
            " --password 'YOUR_2FA_PASSWORD'",
        );
      }
      await client.signInWithPassword(
        { apiId: assertUserApi().apiId, apiHash: assertUserApi().apiHash },
        {
          password: async () => password,
          onError: (e) => {
            throw e;
          },
        },
      );
    } else if (msg.includes("PHONE_CODE_INVALID")) {
      await client.disconnect();
      throw new Error("Invalid code. Request a new one: npm run login -- --phone +79…");
    } else if (msg.includes("PHONE_CODE_EXPIRED")) {
      clearPending();
      await client.disconnect();
      throw new Error("Code expired. Request a new one: npm run login -- --phone +79…");
    } else {
      await client.disconnect();
      throw err;
    }
  }

  if (!(await client.checkAuthorization())) {
    // Password path via client.start helper if still needed
    if (password) {
      await client.signInWithPassword(
        { apiId: assertUserApi().apiId, apiHash: assertUserApi().apiHash },
        {
          password: async () => password,
          onError: (e) => {
            throw e;
          },
        },
      );
    }
  }

  await finishOk(client);
}

/** Fully interactive (real terminal only). */
async function interactiveLogin() {
  if (!process.stdin.isTTY) {
    printHelp();
    throw new Error(
      "No TTY for interactive login. Use --phone / --code flags (see above).",
    );
  }
  const rl = readline.createInterface({ input, output });
  try {
    const phone = (await rl.question("Phone (+7900…): ")).trim();
    await sendCode(phone);
    const code = (await rl.question("Code from Telegram: ")).trim();
    let password = "";
    // signInWithCode opens its own client; pending already saved
    try {
      await signInWithCode(code, password);
    } catch (err) {
      if (String(err.message || err).includes("2FA")) {
        password = (await rl.question("2FA password: ")).trim();
        await signInWithCode(code, password);
      } else {
        throw err;
      }
    }
  } finally {
    rl.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  console.log("Telegram user login");
  console.log(`  API_ID: ${config.apiId}`);
  console.log(`  session: ${config.sessionPath}`);
  console.log(`  channel: @${config.channelUsername}`);
  console.log("");

  // Already have a valid session?
  {
    const client = await createClient();
    if (await client.checkAuthorization()) {
      console.log("Existing session is valid.");
      await finishOk(client);
      return;
    }
    await client.disconnect();
  }

  if (args.phone && args.code) {
    await sendCode(args.phone);
    await signInWithCode(args.code, args.password);
    return;
  }
  if (args.phone && !args.code) {
    await sendCode(args.phone);
    return;
  }
  if (args.code) {
    await signInWithCode(args.code, args.password);
    return;
  }

  await interactiveLogin();
}

main().catch((err) => {
  console.error("\n" + (err.message || err));
  process.exit(1);
});
