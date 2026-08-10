# telegram-monthly-top

Automation for the public Telegram channel [@krasiviyded](https://t.me/krasiviyded):

1. **Monthly top** — rank last month’s photo posts by total reactions → poll + album (preview-first)
2. **Admin daily queue** — you drop media in the bot DM; one post/day at a random time (10:00–22:00 MSK)
3. **Members queue** — media from **channel Direct Messages**; priority over admin; up to 4 posts/day when no admin post that day
4. **Film-phrase replies** — random line from a curated quote list instead of dry “queued” notices
5. **Poll → avatar** — 5 days after a monthly poll, stop the poll and set the winning photo as the channel profile picture

Deployed on **Vercel** (webhook + cron). Local long-polling is optional for development.

## Features

| Area | Behavior |
|------|----------|
| Monthly top | GramJS user session reads history + reactions; bot posts album/poll after admin ✅ |
| Admin queue | Photos/videos in bot DM; browse with ◀️▶️; post now / delete; next-day notify |
| Members queue | Channel DMs (and non-admin media on the bot); albums 1–10 mixed photo/video; caption kept |
| Day rules | Members first; if admin already posted today → members wait; else members ≤ 4/day |
| Replies | `src/data/reply-phrases.json` — full quotes only (source language corpus) |

## Stack

- Node.js ≥ 20, ESM
- [grammY](https://grammy.dev) — Bot API (webhook / publish)
- [GramJS `telegram`](https://github.com/gram-js/gramjs) — user session (history, monoforum poll)
- [@vercel/blob](https://vercel.com/docs/storage/vercel-blob) — queue state / pending / phrases staging
- Vercel serverless: `api/webhook`, `api/cron`, `api/queue-cron`, `api/preview`

## Project layout

```
api/                 Vercel handlers
src/
  botApp.js          Bot commands, keyboards, ingest
  queue/             Admin media queue
  members/           Members (UGC) queue + monoforum poll
  scheduler/         Per-day post counters
  data/reply-phrases.json
  format.js          Channel poll copy (historical channel locale)
scripts/             set-webhook, env-check
AGENTS.md            Architecture for coding agents
DEPLOY.md            Production setup
```

## Local setup

```bash
nvm use 20
cp .env.example .env   # fill secrets locally — never commit .env
npm install
npm run login -- --phone +1…   # then --code …
npm run bot                    # long polling (dev only)
npm run preview-month          # monthly preview once
```

## Production (summary)

See **[DEPLOY.md](./DEPLOY.md)**.

```bash
npx vercel --prod
PUBLIC_URL=https://your-app.vercel.app npm run set-webhook
# Hobby: hit queue tick every 15m via external cron / GitHub Actions
curl "https://your-app.vercel.app/api/queue-cron?secret=$CRON_SECRET"
```

## Bot UI (admin DM)

| Control | Action |
|---------|--------|
| 📊 Preview | Monthly top → DM draft → ✅/❌ publish |
| 📋 Queue | Browse admin queue |
| 👥 Members queue | Browse UGC queue |
| ℹ️ Help | Short help |

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run bot` | Local long polling |
| `npm run login` | User MTProto session |
| `npm run preview-month` | Monthly collect + DM preview |
| `npm run set-webhook` | Point Telegram at `PUBLIC_URL` |
| `npm run env-check` | List env keys (values redacted) |

## Secrets

Never commit:

- `.env`, `STRING_SESSION`, bot tokens, Blob tokens, session files
- `.vercel/`, `data/` runtime state (except empty placeholders)

Use `.env.example` as the template.

## Note on locale content

- **Operational code, docs, and admin bot UI** are English.
- **Channel poll titles** (`format.js`) and **reply phrase corpus** stay in the channel’s language — that is intentional product content, not UI chrome.

## License

MIT
