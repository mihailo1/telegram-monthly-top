/**
 * Collect channel posts + reaction totals for a date range (GramJS user session).
 */
import { config } from "./config.js";
import { previousMonthRange } from "./month.js";
import { disconnectUserClient, getUserClient } from "./userClient.js";

/**
 * @typedef {import('./rank.js').RankablePost & {
 *   messageLink?: string,
 *   rawMessage?: import('telegram').Api.Message,
 *   photoBuffer?: Buffer,
 * }} CollectedPost
 */

/**
 * @param {object} [opts]
 * @param {string} [opts.channel] username without @
 * @param {Date} [opts.from]
 * @param {Date} [opts.to]
 * @param {import('telegram').TelegramClient} [opts.client] reuse client
 * @param {boolean} [opts.downloadPhotos] download photo bytes for top posts later
 * @returns {Promise<CollectedPost[]>}
 */
export async function collectPostsWithReactions(opts = {}) {
  const channel = (opts.channel || config.channelUsername).replace(/^@/, "");
  let range = null;
  if (opts.from && opts.to) {
    range = { from: opts.from, to: opts.to };
  } else {
    range = previousMonthRange(config.timeZone);
  }

  const ownClient = !opts.client;
  const client = opts.client || (await getUserClient({ interactive: true }));

  try {
    const entity = await client.getEntity(channel);
    const fromTs = Math.floor(range.from.getTime() / 1000);
    const toTs = Math.floor(range.to.getTime() / 1000);

    /** @type {CollectedPost[]} */
    const posts = [];

    // Newest first; stop once we pass the start of the window
    for await (const message of client.iterMessages(entity, {
      offsetDate: toTs,
    })) {
      if (!message || !message.date) continue;
      if (message.date >= toTs) continue;
      if (message.date < fromTs) break;

      if (!messageHasPhoto(message)) continue;

      const score = sumReactions(message);
      const username =
        entity.username || config.channelUsername || channel;
      const messageLink = entity.username
        ? `https://t.me/${entity.username}/${message.id}`
        : `https://t.me/c/${String(entity.id).replace(/^-100/, "")}/${message.id}`;

      posts.push({
        id: message.id,
        score,
        date: new Date(message.date * 1000),
        caption: message.message || "",
        messageLink,
        rawMessage: message,
      });
    }

    return posts;
  } finally {
    if (ownClient) {
      await disconnectUserClient(client);
    }
  }
}

/**
 * Download photo bytes for a list of collected posts (mutates with photoBuffer).
 * @param {import('telegram').TelegramClient} client
 * @param {CollectedPost[]} posts
 */
export async function downloadPostPhotos(client, posts) {
  for (const post of posts) {
    if (!post.rawMessage) continue;
    try {
      const buf = await client.downloadMedia(post.rawMessage, {});
      if (buf && Buffer.isBuffer(buf)) {
        post.photoBuffer = buf;
      } else if (buf instanceof Uint8Array) {
        post.photoBuffer = Buffer.from(buf);
      } else if (typeof buf === "string") {
        // path written to disk — read it
        const fs = await import("node:fs");
        post.photoBuffer = fs.readFileSync(buf);
      }
    } catch (err) {
      console.warn(`Failed to download photo for msg ${post.id}:`, err.message);
    }
  }
  return posts;
}

function messageHasPhoto(message) {
  if (message.photo) return true;
  const media = message.media;
  if (!media) return false;
  const name = media.className || media.constructor?.name || "";
  return name.includes("Photo") || Boolean(media.photo);
}

/**
 * Sum all reaction counts on a message.
 * @param {import('telegram').Api.Message} message
 */
function sumReactions(message) {
  const reactions = message.reactions;
  if (!reactions?.results?.length) return 0;
  let total = 0;
  for (const r of reactions.results) {
    total += r.count || 0;
  }
  return total;
}

/**
 * Convenience: previous month for configured channel.
 */
export async function collectPreviousMonth(opts = {}) {
  const range = previousMonthRange(config.timeZone);
  const posts = await collectPostsWithReactions({
    ...opts,
    from: range.from,
    to: range.to,
  });
  return { posts, range };
}
