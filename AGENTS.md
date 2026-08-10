# AGENTS.md — telegram-monthly-top

Instructions for coding agents. Keep this file updated when architecture or product rules change.

## Product goals

1. **Monthly top** — previous calendar month posts with photos, ranked by **sum of all reaction counts**, publish poll + album after admin confirm.
2. **Admin queue** — operator uploads media to bot DM; one item/day, random time 10:00–22:00 (`APP_TZ`).
3. **Members queue** — media from **channel Direct Messages** (and non-admin media on the bot); priority over admin; up to **4/day** if no admin post that day.
4. **Reply phrases** — random curated quote to the author instead of “you are queued at HH:MM”.

**Preview-first** for monthly top: never auto-publish monthly poll to the channel without ✅.

## Day rules

| Condition | Allowed posts that day |
|-----------|-------------------------|
| Admin already posted | Members **blocked** (schedule next day+) |
| No admin post | Members up to **4** |
| Members active (queued/scheduled) | Admin queue **paused** |
| Members empty | Admin schedules/posts as usual (1/day) |

## Architecture

```
Channel DMs / monoforum ──► (webhook or GramJS poll) ──► members store (Blob)
Admin bot DM ─────────────► botApp ───────────────────► admin queue (Blob)
                                                              │
queue-cron ──► processMembersTick ──► channel posts          │
           ──► processQueueTick ────► channel posts ◄────────┘
           ──► pollChannelDirectMessages (GramJS)

Monthly: collect (GramJS) → rank → DM preview → ✅ → publishAlbumAndPoll
```

| Client | Role |
|--------|------|
| grammY (bot) | Webhook, publish, admin UI, members ingest when updates hit the bot |
| GramJS (user session) | Channel history + reactions; monoforum poll fallback |

## Module map

| Path | Responsibility |
|------|----------------|
| `src/botApp.js` | Commands, keyboards, ingest, browsers |
| `src/queue/*` | Admin media queue store, tick, album batching |
| `src/members/*` | UGC store, place/post, monoforum poll, browser session |
| `src/scheduler/dayState.js` | Per-day admin/members counters |
| `src/format.js` | Monthly poll title/options (channel historical locale) |
| `src/data/reply-phrases.json` | Quote corpus for author replies |
| `api/webhook.js` | Telegram updates (`bot.init` required) |
| `api/queue-cron.js` | Poll + members tick + admin tick |
| `api/cron.js` / `api/preview.js` | Monthly preview |

## Shared post shapes

**Admin queue item:** `{ id, fileId, mediaType?, status, postAt?, postDay?, … }`

**Members item:** `{ id, media: [{fileId, mediaType}], caption, fromUserId?, status, postAt?, … }`

## Coding rules

1. **Language:** Code, comments, docs, and **admin bot chrome** in **English**.  
   Allowed non-English: `reply-phrases.json` (corpus) and monthly poll strings in `format.js` (channel product copy).
2. **Secrets:** Only via env / Vercel env. Never commit `.env`, sessions, tokens.
3. **Serverless:** No `setTimeout`-only album buffering without `waitUntil` / Blob parts. Persist across invocations with Blob.
4. **Pure core:** Keep `rank.js` free of I/O.
5. **Publish helpers:** Prefer `publishAlbumAndPoll` / `publishMemberItem` / `sendQueueMedia` — don’t fork send logic.
6. **Limits:** Media groups 2–10; poll options 2–10; enforce before API calls.
7. **Members priority:** Do not schedule admin posts while members queue has active items.
8. **Node:** ≥ 20, ESM.

## Env (see `.env.example`)

`BOT_TOKEN`, `ADMIN_ID`, `GROUP_CHAT_ID`, `CHANNEL_USERNAME`, `API_ID`, `API_HASH`, `STRING_SESSION`, `CRON_SECRET`, `BLOB_READ_WRITE_TOKEN`, `PUBLIC_URL`, `APP_TZ`, optional `TOP_BASE`/`TOP_MAX`/`WEBHOOK_SECRET`.

## Commands

```bash
npm run bot
npm run login
npm run preview-month
npm run set-webhook
npm run env-check
```

## Status

- [x] Monthly top + preview + ✅/❌
- [x] Admin queue + browser + post now / cancel
- [x] Members queue + browser + multi-media preview
- [x] Channel DM ingest via bot updates + GramJS monoforum poll
- [x] Reply phrase corpus
- [x] Vercel deploy docs
- [ ] Harden monoforum peer discovery if layer fields differ

## When changing this file

Update **Status**, **Day rules**, or **Module map** if product or layout changes.
