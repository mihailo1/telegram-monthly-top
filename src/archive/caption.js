/**
 * Caption for the Sunday archive post, written by Gemini (free tier).
 * Keys: GEMINI_API_KEY (main) and GEMINI_API_KEY_BACKUP, tried in order so a
 * quota error on one falls over to the other. If both fail the post still
 * goes out with a template caption.
 */
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const ENDPOINT = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
const PREFIX = "Архивное:";
const MAX_LEN = 80;

export function geminiKeys() {
  return [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_BACKUP]
    .map((k) => (k || "").trim())
    .filter(Boolean);
}

export function templateCaption(theme) {
  return `${PREFIX} дедушки ${theme.phrase}`;
}

function buildPrompt(theme, photos) {
  const samples = photos
    .slice(0, 3)
    .map((p, i) => `${i + 1}. ${p.desc}`)
    .join("\n");
  return [
    "You write captions for a Russian Telegram channel that posts photos of stylish elderly men (dedushki) spotted on city streets.",
    "This is an archive post: several old photos sharing one theme.",
    `Theme: elderly men ${theme.phrase} (Russian phrase).`,
    `Sample descriptions of the photos:\n${samples}`,
    "",
    `Write ONE short caption in Russian, at most ${MAX_LEN} characters, starting exactly with "${PREFIX} ".`,
    'Warm and slightly witty, no hashtags, no quotes, no emoji except an optional single 👴 at the end.',
    'Example: "Архивное: дедушки на прогулке"',
    "Reply with the caption only.",
  ].join("\n");
}

function cleanCaption(text) {
  const line = String(text || "")
    .split("\n")[0]
    .replace(/^["«“'\s]+|["»”'\s]+$/g, "")
    .trim();
  if (!line.startsWith(PREFIX) || line.length > MAX_LEN + 4) return null;
  return line;
}

async function askGemini(key, prompt, fetchImpl) {
  const res = await fetchImpl(ENDPOINT(MODEL), {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.9,
        maxOutputTokens: 120,
        thinkingConfig: { thinkingBudget: 0 },
      },
    }),
  });
  if (!res.ok) {
    const err = new Error(`gemini http ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  return json?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
}

/**
 * @param {{ theme: object, photos: { desc: string }[], keys?: string[], fetchImpl?: typeof fetch }} opts
 * @returns {Promise<{ caption: string, source: string }>} source: "gemini:main" | "gemini:backup" | "template"
 */
export async function buildCaption({
  theme,
  photos,
  keys = geminiKeys(),
  fetchImpl = fetch,
}) {
  const prompt = buildPrompt(theme, photos);
  for (let i = 0; i < keys.length; i++) {
    try {
      const caption = cleanCaption(await askGemini(keys[i], prompt, fetchImpl));
      if (caption) {
        return { caption, source: i === 0 ? "gemini:main" : "gemini:backup" };
      }
    } catch (err) {
      console.warn(`gemini key ${i + 1} failed:`, err.status || err.message);
    }
  }
  return { caption: templateCaption(theme), source: "template" };
}
