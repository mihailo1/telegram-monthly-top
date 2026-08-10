/**
 * Publish album + poll via Bot API (grammY).
 *
 * Telegram limits:
 * - media group: 2–10 items
 * - poll options: 2–10
 *
 * Channel historical order for @krasiviyded: poll first, then album (no captions).
 */

/**
 * @typedef {{ media: string|import('grammy').InputFile, caption?: string }} PhotoItem
 */

/**
 * @param {import('grammy').Api} api
 * @param {string|number} chatId
 * @param {object} payload
 * @param {PhotoItem[]} payload.photos
 * @param {string|null} [payload.albumCaption]  // put on first photo if set
 * @param {boolean} [payload.perPhotoCaptions]  // default true when albumCaption/captions used
 * @param {string} payload.pollQuestion
 * @param {string[]} [payload.pollOptions] // default: "1".."N"
 * @param {boolean} [payload.isAnonymous]
 * @param {boolean} [payload.allowsMultipleAnswers]
 * @param {boolean} [payload.replyPollToAlbum]
 * @param {"album-then-poll"|"poll-then-album"} [payload.order]
 */
export async function publishAlbumAndPoll(api, chatId, payload) {
  const photos = payload.photos ?? [];
  if (photos.length < 2) {
    throw new Error("Need at least 2 photos for a media group + poll");
  }
  if (photos.length > 10) {
    throw new Error("Telegram allows at most 10 photos in a media group");
  }

  const options =
    payload.pollOptions ?? photos.map((_, i) => String(i + 1));

  if (options.length < 2 || options.length > 10) {
    throw new Error("Poll must have 2–10 options");
  }
  if (options.length !== photos.length) {
    throw new Error("pollOptions length must match photos length");
  }

  const order = payload.order || "album-then-poll";
  const media = buildMediaGroup(photos, payload);

  if (order === "poll-then-album") {
    // Historical @krasiviyded format: poll, then album (no reply link)
    const pollMessage = await api.sendPoll(
      chatId,
      payload.pollQuestion,
      options,
      {
        is_anonymous: payload.isAnonymous ?? true,
        allows_multiple_answers: payload.allowsMultipleAnswers ?? false,
      },
    );
    const albumMessages = await api.sendMediaGroup(chatId, media);
    return { albumMessages, pollMessage, order };
  }

  // Default: album first, poll replies to album
  const albumMessages = await api.sendMediaGroup(chatId, media);
  const firstAlbumId = albumMessages[0]?.message_id;

  const pollMessage = await api.sendPoll(chatId, payload.pollQuestion, options, {
    is_anonymous: payload.isAnonymous ?? true,
    allows_multiple_answers: payload.allowsMultipleAnswers ?? false,
    ...(payload.replyPollToAlbum !== false && firstAlbumId
      ? { reply_parameters: { message_id: firstAlbumId } }
      : {}),
  });

  return { albumMessages, pollMessage, order };
}

function buildMediaGroup(photos, payload) {
  const useCaptions =
    payload.perPhotoCaptions !== false &&
    (payload.albumCaption || photos.some((p) => p.caption));

  if (!useCaptions) {
    // Channel style: bare photos, order = poll option order
    return photos.map((p) => ({
      type: "photo",
      media: p.media,
    }));
  }

  return photos.map((p, i) => {
    const indexCaption = String(i + 1);
    const isFirst = i === 0;
    let caption = p.caption ?? indexCaption;

    if (isFirst && payload.albumCaption) {
      caption = `${payload.albumCaption}\n\n${indexCaption}`;
    }

    return {
      type: "photo",
      media: p.media,
      caption,
      parse_mode: "HTML",
    };
  });
}

/**
 * Build sample photos for dry-run / DM test (public placeholder images).
 * @param {number} count
 */
export function samplePhotos(count = 5) {
  const n = Math.min(10, Math.max(2, count));
  return Array.from({ length: n }, (_, i) => ({
    media: `https://picsum.photos/seed/monthly-top-${i + 1}/800/800`,
    caption: String(i + 1),
  }));
}
