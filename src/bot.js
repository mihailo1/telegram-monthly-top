/**
 * Local long-polling entrypoint.
 * On Vercel use webhook: POST /api/webhook
 */
import { createBot, setupBotMenu } from "./botApp.js";

const bot = createBot();

console.log("Starting bot (long polling)…");
bot.start({
  onStart: async (info) => {
    try {
      await setupBotMenu(bot);
    } catch (err) {
      console.warn("setMyCommands:", err.message ?? err);
    }
    console.log(
      `@${info.username} long-polling. Menu ready. Vercel: use webhook.`,
    );
  },
});

