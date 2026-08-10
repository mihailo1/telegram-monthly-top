# Deploy to Vercel

## Prerequisites

- Vercel account + CLI (`npm i -g vercel` optional)
- Bot is **admin** of `@krasiviyded` (post media + polls)
- Channel **Direct Messages** enabled if you use Members queue via monoforum
- Local login done once (`STRING_SESSION` from `npm run login`)

## 1. Environment variables

Copy from local `.env` into Vercel → Project → Settings → Environment Variables (Production).

| Name | Required | Notes |
|------|----------|--------|
| `BOT_TOKEN` | yes | BotFather |
| `ADMIN_ID` | yes | Your Telegram user id |
| `GROUP_CHAT_ID` | yes | Channel id (`-100…`) |
| `CHANNEL_USERNAME` | yes | e.g. `krasiviyded` |
| `API_ID` / `API_HASH` | yes | https://my.telegram.org/apps |
| `STRING_SESSION` | yes | Contents of `data/user.session` |
| `CRON_SECRET` | yes | Random: `openssl rand -hex 16` |
| `BLOB_READ_WRITE_TOKEN` | yes | Vercel Blob store |
| `PUBLIC_URL` | yes | `https://your-app.vercel.app` |
| `APP_TZ` | recommended | `Europe/Moscow` (`TZ` is reserved on Vercel) |
| `TOP_BASE` / `TOP_MAX` | optional | Defaults 5 / 10 |
| `WEBHOOK_SECRET` | optional | Extra webhook query secret |

Do **not** set `TZ` on Vercel (reserved name).

## 2. Blob store

Vercel Dashboard → Storage → Blob → create → connect to project → copy `BLOB_READ_WRITE_TOKEN`.

Without Blob, queue / pending / browser session state will not persist across serverless invocations.

## 3. Deploy

```bash
cd path/to/telegram-monthly-top
npx vercel --prod
```

## 4. Webhook

```bash
PUBLIC_URL=https://your-app.vercel.app npm run set-webhook
```

Or:

```text
https://your-app.vercel.app/api/setup-webhook?secret=CRON_SECRET
```

Do **not** run local `npm run bot` at the same time as the production webhook.

## 5. Crons

`vercel.json`:

| Path | Schedule | Role |
|------|----------|------|
| `/api/cron` | `0 6 6 * *` | Monthly preview (~09:00 MSK on the 6th) |
| `/api/queue-cron` | `0 7 * * *` | Daily backup tick (Hobby-friendly) |

**Hobby plan** only allows once-per-day crons. For random 10:00–22:00 posts and timely members ingest, call `/api/queue-cron` every **15 minutes** via:

- [cron-job.org](https://cron-job.org), or
- GitHub Actions workflow `.github/workflows/queue-tick.yml`  
  Secret: `QUEUE_CRON_URL=https://…/api/queue-cron?secret=CRON_SECRET`

## 6. Smoke tests

```bash
# Webhook alive
curl -sS https://your-app.vercel.app/api/webhook

# Queue + members tick
curl -sS "https://your-app.vercel.app/api/queue-cron?secret=$CRON_SECRET"

# Monthly preview (admin DM)
curl -sS -X POST "https://your-app.vercel.app/api/preview?secret=$CRON_SECRET"
```

In Telegram: open the bot → `/start` → **Preview** / **Queue** / **Members queue**.

## Limits

- Function `maxDuration` is set to 60s where needed.
- Treat `STRING_SESSION` like a password (full account access).
- After `npm run login` again, update `STRING_SESSION` on Vercel and redeploy if required.
