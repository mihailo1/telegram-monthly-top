/**
 * Local CLI: collect previous month → DM preview + ✅/❌ buttons.
 * On Vercel: GET/POST /api/cron or /api/preview
 */
import { runMonthlyPreview } from "./runPreview.js";

runMonthlyPreview({ interactive: true })
  .then((r) => {
    console.log("OK", r);
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
