#!/usr/bin/env bash
# Deploy to Vercel production with version info, then poke the tick so the
# bot DMs the admin a "Deployed vX (commit)" notice right away.
set -euo pipefail
cd "$(dirname "$0")/.."

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then . "$NVM_DIR/nvm.sh"; nvm use 20 >/dev/null 2>&1 || true; fi

commit="$(git rev-parse --short HEAD)"
[ -n "$(git status --porcelain)" ] && commit="${commit}+dirty"
subject="$(git log -1 --pretty=%s)"
built="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

vercel --prod --yes \
  -e APP_COMMIT="$commit" \
  -e APP_COMMIT_SUBJECT="$subject" \
  -e APP_BUILT_AT="$built"

secret=""
[ -f .env ] && secret="$(grep -E '^CRON_SECRET=' .env | head -1 | cut -d= -f2- | tr -d "\"'")"
if [ -n "$secret" ]; then
  echo "Poking tick for the deploy notice..."
  curl -fsS -m 60 "https://telegram-monthly-top.vercel.app/api/queue-cron?secret=${secret}" >/dev/null && echo "tick ok"
fi
