/**
 * Ingest channel Direct Messages (monoforum) via user MTProto session.
 *
 * Requires:
 * - Channel Direct Messages enabled (Channel Settings → Direct Messages)
 * - STRING_SESSION is a channel admin account
 *
 * Falls back gracefully if monoforum API shape differs by layer.
 */
import { Api } from "telegram";
import { config } from "../config.js";
import { disconnectUserClient, getUserClient } from "../userClient.js";
import {
  appendMemberPost,
  markSourceSeen,
  updateMemberItem,
  wasSourceSeen,
} from "./store.js";
import { placeMemberItem } from "./process.js";
import { Bot } from "grammy";
import { assertBotToken } from "../config.js";

/**
 * Extract photo/video from a GramJS message.
 * @param {import('telegram').Api.Message} msg
 */
function extractMediaFromMessage(msg) {
  if (!msg) return null;
  if (msg.photo) {
    // GramJS photo — bot needs file_id from Bot API; MTProto has different ids.
    // We'll download and re-upload via bot for channel post reliability.
    return { kind: "photo", raw: msg };
  }
  if (msg.video || msg.document) {
    const doc = msg.video || msg.document;
    const isVideo =
      msg.video ||
      (doc?.mimeType && String(doc.mimeType).startsWith("video/"));
    if (isVideo) return { kind: "video", raw: msg };
  }
  return null;
}

/**
 * Download media bytes from user client and upload to bot to get file_id.
 * @param {import('telegram').TelegramClient} client
 * @param {import('grammy').Bot} bot
 * @param {import('telegram').Api.Message} msg
 * @param {"photo"|"video"} kind
 */
async function toBotFileId(client, bot, msg, kind) {
  const buf = await client.downloadMedia(msg, {});
  const buffer = Buffer.isBuffer(buf)
    ? buf
    : buf instanceof Uint8Array
      ? Buffer.from(buf)
      : null;
  if (!buffer) throw new Error("download failed");

  const { InputFile } = await import("grammy");
  // Upload to admin chat (or getMe chat) as temporary to obtain file_id
  const adminId = config.adminId;
  if (!adminId) throw new Error("ADMIN_ID required to stage media");

  if (kind === "video") {
    const sent = await bot.api.sendVideo(
      adminId,
      new InputFile(buffer, `m_${msg.id}.mp4`),
      { disable_notification: true },
    );
    // delete staging message to reduce clutter
    try {
      await bot.api.deleteMessage(adminId, sent.message_id);
    } catch {
      /* ignore */
    }
    return sent.video.file_id;
  }

  const sent = await bot.api.sendPhoto(
    adminId,
    new InputFile(buffer, `m_${msg.id}.jpg`),
    { disable_notification: true },
  );
  try {
    await bot.api.deleteMessage(adminId, sent.message_id);
  } catch {
    /* ignore */
  }
  const sizes = sent.photo;
  return sizes[sizes.length - 1].file_id;
}

/**
 * Poll monoforum / channel DMs for new media messages.
 * @returns {Promise<{ scanned: number, ingested: number, actions: string[] }>}
 */
export async function pollChannelDirectMessages() {
  const summary = { scanned: 0, ingested: 0, actions: [] };
  let client;
  const bot = new Bot(assertBotToken());
  await bot.init();

  try {
    client = await getUserClient({ interactive: false });
    const channel = await client.getEntity(config.channelUsername);

    // Resolve monoforum / linked DM peer
    let monoPeer = null;
    try {
      const full = await client.invoke(
        new Api.channels.GetFullChannel({ channel }),
      );
      const fullChat = full.fullChat;
      // Various layer field names
      const monoId =
        fullChat.linkedMonoforumId ||
        fullChat.monoforumId ||
        fullChat.linked_monoforum_id;
      if (monoId) {
        monoPeer = await client.getEntity(monoId);
      }
      // Some layers: fullChat.flags / replies_chat?
      if (!monoPeer && fullChat.migratedFromChatId) {
        /* not monoforum */
      }
    } catch (err) {
      summary.actions.push(`full_channel_error:${err.message}`);
    }

    if (!monoPeer) {
      // Fallback: scan recent dialogs for monoforum-like peers related to channel
      summary.actions.push("no_monoforum_entity");
      // Try InputPeer from channel broadcast with monoforum flag — layer dependent
      try {
        for await (const dialog of client.iterDialogs({ limit: 50 })) {
          const ent = dialog.entity;
          const title = (ent.title || ent.username || "").toString();
          // monoforum chats often named after channel or have className
          const cls = ent.className || ent.constructor?.name || "";
          if (
            cls.includes("Channel") &&
            (ent.megagroup || ent.gigagroup) &&
            title.toLowerCase().includes(
              (config.channelUsername || "").toLowerCase(),
            )
          ) {
            // weak heuristic — skip
          }
          if (cls.includes("Mono") || dialog.isChannel === false) {
            // continue search
          }
        }
      } catch {
        /* ignore */
      }

      // Last resort: cannot poll — document for admin
      summary.actions.push(
        "enable_channel_direct_messages_and_update_gramjs_layer",
      );
      return summary;
    }

    // Collect messages (grouped by groupedId)
    /** @type {Map<string, import('telegram').Api.Message[]>} */
    const groups = new Map();
    const singles = [];

    for await (const msg of client.iterMessages(monoPeer, { limit: 40 })) {
      summary.scanned += 1;
      if (!msg || msg.out) continue; // skip outgoing admin replies
      const media = extractMediaFromMessage(msg);
      if (!media) continue; // ignore pure text

      if (msg.groupedId) {
        const gid = String(msg.groupedId);
        if (!groups.has(gid)) groups.set(gid, []);
        groups.get(gid).push(msg);
      } else {
        singles.push(msg);
      }
    }

    const botReady = bot;

    async function ingestMessageList(msgs) {
      msgs.sort((a, b) => a.id - b.id);
      const sourceKey = `mono_${msgs.map((m) => m.id).join("_")}`;
      if (await wasSourceSeen(sourceKey)) return;

      const media = [];
      for (const msg of msgs) {
        const extracted = extractMediaFromMessage(msg);
        if (!extracted) continue;
        const kind = extracted.kind === "video" ? "video" : "photo";
        try {
          const fileId = await toBotFileId(client, botReady, msg, kind);
          media.push({ fileId, mediaType: kind });
        } catch (err) {
          summary.actions.push(`stage_fail:${msg.id}:${err.message}`);
        }
      }
      if (media.length < 1 || media.length > 10) {
        await markSourceSeen(sourceKey);
        return;
      }

      const caption = msgs.find((m) => m.message)?.message || "";
      const from = msgs[0].fromId;
      let fromUserId = "";
      let fromUsername = "";
      try {
        if (from) {
          const u = await client.getEntity(from);
          fromUserId = String(u.id || "");
          fromUsername = u.username || "";
        }
      } catch {
        /* ignore */
      }

      const item = await appendMemberPost({
        media,
        caption,
        fromUserId,
        fromUsername,
        sourceKey,
      });
      await markSourceSeen(sourceKey);
      // Bot API may not reach monoforum; phrase via bot if user has DM, else GramJS below
      const placed = await placeMemberItem(item, botReady);
      if (!placed.authorNotified) {
        try {
          const { randomReplyPhrase } = await import("../replyPhrases.js");
          const phrase = placed.phrase || randomReplyPhrase();
          await client.sendMessage(monoPeer, {
            message: phrase,
            replyTo: msgs[0].id,
          });
          await updateMemberItem(item.id, { authorNotified: true });
          summary.actions.push(`phrase_mtproto:${item.id}`);
        } catch (err) {
          summary.actions.push(
            `phrase_fail:${item.id}:${err.message || err}`,
          );
        }
      }
      summary.ingested += 1;
      summary.actions.push(`ingested:${item.id}`);
    }

    for (const [, msgs] of groups) {
      await ingestMessageList(msgs);
    }
    for (const msg of singles) {
      await ingestMessageList([msg]);
    }
  } catch (err) {
    summary.actions.push(`poll_error:${err.message}`);
    console.error("pollChannelDirectMessages", err);
  } finally {
    await disconnectUserClient(client);
  }

  return summary;
}
