/**
 * Random reply lines from the film dub transcript (filtered full phrases).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PHRASES_PATH = path.join(__dirname, "data", "reply-phrases.json");

/** @type {string[] | null} */
let cache = null;

export function loadReplyPhrases() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(PHRASES_PATH, "utf8");
    const list = JSON.parse(raw);
    cache = Array.isArray(list) ? list.filter((s) => typeof s === "string" && s.trim()) : [];
  } catch (err) {
    console.error("loadReplyPhrases failed", err.message);
    cache = [
      "Откройте дверь, пожалуйста, прошу вас, откройте!",
      "Не бросайте меня, не пропадайте",
    ];
  }
  return cache;
}

export function randomReplyPhrase() {
  const list = loadReplyPhrases();
  if (!list.length) return "Откройте дверь, пожалуйста, прошу вас, откройте!";
  return list[Math.floor(Math.random() * list.length)];
}
