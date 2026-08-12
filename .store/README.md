# store-data branch (bot runtime state)

This branch is **operational storage** for telegram-monthly-top when Vercel Blob is unavailable.
It is not application source code.

## Contents
- `queue/items/*.json` — admin queue entries (Telegram file_ids only)
- `queue/notify-lock/*` — short-lived **mutex claim ids** (not API keys / secrets)
- `members/*`, `scheduler/*` — UGC queue / day counters

## GitGuardian / secret scanners
Files under `queue/notify-lock/` and album `lock.json` contain random **claimId** strings used only to prevent double-notify races. They are **not** credentials. Mark as false positive if flagged.

Do not store BOT_TOKEN, STRING_SESSION, or real API keys here.
