/**
 * App version info. `version` comes from package.json; commit, subject and
 * build time are injected as runtime env by scripts/deploy.sh.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function packageVersion() {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
    ).version;
  } catch {
    return "unknown";
  }
}

export function appVersion() {
  return {
    version: packageVersion(),
    commit: process.env.APP_COMMIT || "",
    subject: process.env.APP_COMMIT_SUBJECT || "",
    builtAt: process.env.APP_BUILT_AT || "",
    deploymentId: process.env.VERCEL_DEPLOYMENT_ID || "",
  };
}

/** Stable id of this deployment, or "" when running locally. */
export function deployIdentity() {
  const v = appVersion();
  return v.builtAt || v.deploymentId || "";
}

export function versionLine() {
  const v = appVersion();
  return `v${v.version}${v.commit ? ` (${v.commit})` : ""}`;
}
