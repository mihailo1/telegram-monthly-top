/**
 * DM the admin once per new deployment: version, commit, build time.
 * Runs from the 15-minute tick; deploy.sh also pokes the tick right after a
 * deploy so the notice arrives immediately.
 */
import { sendAlertOnce } from "./alerts.js";
import { appVersion, deployIdentity } from "./version.js";

const DAY_MS = 24 * 60 * 60 * 1000;
let checked = false;

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** @returns {Promise<boolean>} true if a notice was sent */
export async function checkDeployNotice(bot) {
  if (checked) return false;
  const identity = deployIdentity();
  if (!identity) return false;
  checked = true;

  const v = appVersion();
  const lines = [
    `🚀 <b>Deployed v${escapeHtml(v.version)}</b>${v.commit ? ` (<code>${escapeHtml(v.commit)}</code>)` : ""}`,
    v.subject ? escapeHtml(v.subject) : "",
    v.builtAt ? `Built: ${escapeHtml(v.builtAt.replace("T", " ").replace(/:\d\dZ$/, " UTC"))}` : "",
    v.deploymentId ? `Deployment: <code>${escapeHtml(v.deploymentId)}</code>` : "",
  ].filter(Boolean);

  return sendAlertOnce(bot, `deploy:${identity}`, lines.join("\n"), 30 * DAY_MS, {
    silent: true,
  });
}
