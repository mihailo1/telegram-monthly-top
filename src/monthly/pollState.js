/**
 * Live vote-count cache for polls we keep open.
 *
 * Telegram never exposes "current results without closing" as an API call —
 * the only way to see votes on a live poll is the `poll` update pushed to the
 * bot on every vote. We persist the latest one per poll id so a later cron
 * tick can read a snapshot without calling stopPoll.
 */
import { put, getJson } from "../storage/blob.js";

const PREFIX = "monthly/poll-state/";

function statePath(pollId) {
  return `${PREFIX}${pollId}.json`;
}

/**
 * @param {import('grammy/types').Poll} poll
 */
export async function savePollState(poll) {
  if (!poll?.id) return;
  const body = JSON.stringify(
    {
      id: poll.id,
      options: poll.options,
      totalVoterCount: poll.total_voter_count,
      isClosed: poll.is_closed,
      updatedAt: new Date().toISOString(),
    },
    null,
    2,
  );
  await put(statePath(poll.id), body, {
    access: "public",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

/**
 * @param {string} pollId
 * @returns {Promise<{ id: string, options: { text: string, voter_count: number }[], totalVoterCount: number, isClosed: boolean, updatedAt: string } | null>}
 */
export async function getPollState(pollId) {
  if (!pollId) return null;
  try {
    return await getJson(statePath(pollId));
  } catch {
    return null;
  }
}
