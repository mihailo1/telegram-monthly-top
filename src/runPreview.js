/**
 * Shared monthly preview pipeline (local CLI + Vercel cron).
 */
import { Bot, InlineKeyboard, InputFile } from "grammy";
import {
  assertAdminId,
  assertBotToken,
  config,
} from "./config.js";
import {
  collectPostsWithReactions,
  downloadPostPhotos,
} from "./collect.js";
import { channelMonthlyFormat, rankingLine } from "./format.js";
import { previousMonthRange } from "./month.js";
import { createPending, updatePending } from "./pending.js";
import { publishAlbumAndPoll } from "./publish.js";
import { rankTopPosts } from "./rank.js";
import { disconnectUserClient, getUserClient } from "./userClient.js";

/**
 * Largest photo size file_id from a Bot API message.
 * @param {import('@grammyjs/types').Message} message
 */
export function bestPhotoFileId(message) {
  const sizes = message.photo;
  if (!sizes?.length) return null;
  return sizes[sizes.length - 1].file_id;
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.interactive] GramJS login if needed
 * @returns {Promise<{ pendingId: string, topCount: number, scanned: number, rangeLabel: string }>}
 */
export async function runMonthlyPreview(opts = {}) {
  const adminId = assertAdminId();
  const botToken = assertBotToken();
  const range = previousMonthRange(config.timeZone);

  console.log(`Collecting @${config.channelUsername}`);
  console.log(
    `  window: ${range.from.toISOString()} → ${range.to.toISOString()} (${range.label})`,
  );

  const client = await getUserClient({
    interactive: opts.interactive ?? false,
  });
  const bot = new Bot(botToken);

  try {
    const posts = await collectPostsWithReactions({
      client,
      from: range.from,
      to: range.to,
    });
    console.log(`  photo posts found: ${posts.length}`);

    const ranked = rankTopPosts(posts, {
      topBase: config.topBase,
      topMax: config.topMax,
    });
    console.log(`  top after rank: ${ranked.length}`);

    if (ranked.length === 0) {
      await bot.api.sendMessage(
        adminId,
        `No photo posts for <b>${range.label}</b> to @${config.channelUsername}.`,
        { parse_mode: "HTML" },
      );
      return {
        pendingId: "",
        topCount: 0,
        scanned: posts.length,
        rangeLabel: range.label,
      };
    }

    await downloadPostPhotos(client, ranked);
    const withPhotos = ranked.filter((p) => p.photoBuffer);

    if (withPhotos.length < 2) {
      await bot.api.sendMessage(
        adminId,
        `Need ≥2 downloaded photos (got ${withPhotos.length}).`,
      );
      throw new Error(`Need ≥2 photos, got ${withPhotos.length}`);
    }

    const format = channelMonthlyFormat({
      month: range.month,
      photoCount: withPhotos.length,
    });

    const lines = withPhotos.map((p, i) =>
      rankingLine(p, i, config.timeZone),
    );
    const totalLikes = withPhotos.reduce((s, p) => s + p.score, 0);

    await bot.api.sendMessage(
      adminId,
      [
        `📊 <b>Preview</b> — top for <b>${range.label}</b>`,
        `@${config.channelUsername}`,
        `Photo posts scanned: ${posts.length}`,
        `In top: ${withPhotos.length} · sum of likes in top: <b>${totalLikes}</b>`,
        "",
        ...lines,
        "",
        `Channel format:`,
        `1) poll “${format.pollQuestion}»`,
        `2) album without captions (${format.pollOptions.join(" ")})`,
        "",
        "Draft below (DM only). Publish with ✅.",
      ].join("\n"),
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
    );

    const photos = withPhotos.map((p) => ({
      media: new InputFile(p.photoBuffer, `top_${p.id}.jpg`),
    }));

    const { albumMessages } = await publishAlbumAndPoll(bot.api, adminId, {
      photos,
      ...format,
    });

    const fileIds = albumMessages.map((m) => {
      const id = bestPhotoFileId(m);
      if (!id) throw new Error(`No file_id on album message ${m.message_id}`);
      return id;
    });

    const pending = await createPending({
      fileIds,
      posts: withPhotos,
      format,
      range,
    });

    const keyboard = new InlineKeyboard()
      .text("✅ To channel", `publish:${pending.id}`)
      .text("❌ Cancel", `cancel:${pending.id}`);

    const target = config.groupChatId
      ? `@${config.channelUsername} (<code>${config.groupChatId}</code>)`
      : "⚠️ GROUP_CHAT_ID not set";

    const kbMsg = await bot.api.sendMessage(
      adminId,
      [
        `Publish this top to the channel?`,
        `Target: ${target}`,
        `pending: <code>${pending.id}</code>`,
      ].join("\n"),
      { parse_mode: "HTML", reply_markup: keyboard },
    );

    await updatePending(pending.id, { adminMessageId: kbMsg.message_id });

    console.log(`Preview sent. pending=${pending.id}`);
    return {
      pendingId: pending.id,
      topCount: withPhotos.length,
      scanned: posts.length,
      rangeLabel: range.label,
    };
  } finally {
    await disconnectUserClient(client);
  }
}
