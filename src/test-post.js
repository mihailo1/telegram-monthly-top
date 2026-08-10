/**
 * One-shot: send test album + poll to ADMIN_ID (private messages).
 *
 * Usage:
 *   1. Fill BOT_TOKEN and ADMIN_ID in .env
 *   2. npm run test-post
 *   3. Open Telegram DM with the bot
 */
import { Bot } from "grammy";
import { assertAdminId, config } from "./config.js";
import { publishAlbumAndPoll, samplePhotos } from "./publish.js";

async function main() {
  const adminId = assertAdminId();
  const bot = new Bot(config.botToken);

  const me = await bot.api.getMe();
  console.log(`Bot @${me.username} → DM chat ${adminId}`);

  // Ensure user has started the bot (otherwise send fails with 403)
  try {
    await bot.api.sendChatAction(adminId, "typing");
  } catch (err) {
    console.error(
      "\nCannot message ADMIN_ID. Open the bot in Telegram and press Start / send /start, then retry.\n",
    );
    throw err;
  }

  const count = Number(process.argv[2]) || 5;
  const photos = samplePhotos(count);
  const monthLabel = previousMonthLabel(config.timeZone);

  console.log(`Sending album (${photos.length} photos) + poll…`);

  const { albumMessages, pollMessage } = await publishAlbumAndPoll(
    bot.api,
    adminId,
    {
      photos,
      albumCaption: `🧪 <b>Test</b>: top posts for ${monthLabel}\nPhoto number = poll option below`,
      pollQuestion: `🧪 Test: best post for ${monthLabel}? (number = photo above)`,
      isAnonymous: true,
      allowsMultipleAnswers: false,
      replyPollToAlbum: true,
    },
  );

  console.log("OK");
  console.log(
    `  album messages: ${albumMessages.map((m) => m.message_id).join(", ")}`,
  );
  console.log(`  poll message: ${pollMessage.message_id}`);
  console.log("\nCheck your private chat with the bot.");
}

function previousMonthLabel(timeZone) {
  const now = new Date();
  // Step back one calendar month for the label (full TZ month math comes later).
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return d.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
