/**
 * Set channel avatar from current July poll leader WITHOUT closing the poll.
 * Poll 1721, album 1722..1728, winner option index 1 (2️⃣) → msg 1723.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Bot, InputFile } from "grammy";
import { config, assertBotToken } from "../src/config.js";
import { getUserClient, disconnectUserClient } from "../src/userClient.js";
import { put } from "../src/storage/blob.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const POLL_MSG_ID = 1721;
const WINNER_INDEX = 1;
const WINNER_MSG_ID = 1722 + WINNER_INDEX;

const bot = new Bot(assertBotToken());
await bot.init();
const client = await getUserClient({ interactive: false });

try {
  const channel = await client.getEntity(config.channelUsername);
  const [pm] = await client.getMessages(channel, { ids: [POLL_MSG_ID] });
  if (!pm) throw new Error("poll message not found");

  const mediaClass = pm.media?.className || pm.media?.constructor?.name || "";
  if (!mediaClass.includes("Poll")) {
    throw new Error(`message ${POLL_MSG_ID} is not a poll: ${mediaClass}`);
  }
  if (pm.media.poll?.closed) {
    console.warn("Poll already closed — continuing with setChatPhoto only");
  }

  const votes = (pm.media.results?.results || []).map((r) => r.voters || 0);
  const leader = votes.indexOf(Math.max(...votes));
  console.log({ votes, leader, leaderVotes: votes[leader], WINNER_MSG_ID });

  const [wm] = await client.getMessages(channel, { ids: [WINNER_MSG_ID] });
  if (!wm?.photo) throw new Error(`message ${WINNER_MSG_ID} has no photo`);

  const buf = await client.downloadMedia(wm, {});
  const buffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const tmp = path.join(ROOT, "data", "tmp-avatar-winner.jpg");
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.writeFileSync(tmp, buffer);
  console.log("Downloaded", buffer.length, "bytes");

  await bot.api.setChatPhoto(
    config.groupChatId,
    new InputFile(tmp, "winner_july.jpg"),
  );
  console.log("setChatPhoto OK — poll left open");

  const jobId = `backfill-july-${Date.now().toString(36)}`;
  await put(
    `monthly/avatar-jobs/${jobId}.json`,
    JSON.stringify(
      {
        id: jobId,
        status: "done",
        createdAt: "2026-08-10T14:49:19.000Z",
        processAfter: new Date().toISOString(),
        chatId: String(config.groupChatId),
        channelUsername: config.channelUsername,
        pollMessageId: POLL_MSG_ID,
        photoFileIds: [],
        rangeLabel: "July 2026",
        pollQuestion: "Лучший дед июля 👴",
        winnerIndex: WINNER_INDEX,
        winnerVotes: votes[WINNER_INDEX],
        completedAt: new Date().toISOString(),
        note: `setChatPhoto without stopPoll; option 2️⃣ from msg ${WINNER_MSG_ID}`,
      },
      null,
      2,
    ),
    {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: true,
    },
  );
  console.log("Audit job saved", jobId);
  try {
    fs.unlinkSync(tmp);
  } catch {
    /* ignore */
  }
} catch (err) {
  console.error("FAIL", err);
  process.exitCode = 1;
} finally {
  await disconnectUserClient(client);
}
