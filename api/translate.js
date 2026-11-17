// 번역: Cloudflare Workers AI
//  1순위 다국어 AI 모델(자연스러운 번역) → 실패하면 번역 전용 모델(m2m100)

export const LANGS = {
  ko: "Korean", en: "English", ja: "Japanese", zh: "Chinese (Simplified)", es: "Spanish", fr: "French",
  de: "German", vi: "Vietnamese", th: "Thai", id: "Indonesian", ru: "Russian", it: "Italian", pt: "Portuguese",
};
const LLMS = ["@cf/google/gemma-3-12b-it"];
const MT = "@cf/meta/m2m100-1.2b";

function clean(s) {
  s = String(s || "").trim();
  s = s.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  s = s.replace(/^(translation|번역)\s*[:：]\s*/i, "");
  if (/^["“「『].*["”」』]$/s.test(s)) s = s.slice(1, -1).trim();   // 앞뒤 따옴표만 감싼 경우 벗김
  return s;
}

async function viaLLM(ai, model, text, src, tgt) {
  const out = await ai.run(model, {
    messages: [
      { role: "system", content: `You are a translation engine. Translate the user's text from ${LANGS[src]} to ${LANGS[tgt]}. Keep the meaning, tone and line breaks. Output only the translation — no explanations, notes, romanization or quotes.` },
      { role: "user", content: text },
    ],
    temperature: 0.2,
    max_tokens: Math.min(2048, 64 + text.length * 4),
  });
  const t = out && (out.response ?? (out.choices && out.choices[0] && out.choices[0].message && out.choices[0].message.content));
  if (!t || !String(t).trim()) throw new Error("empty");
  return clean(t);
}

async function viaMT(ai, text, src, tgt) {
  const out = await ai.run(MT, { text, source_lang: src, target_lang: tgt });
  if (!out || !out.translated_text) throw new Error("empty");
  return out.translated_text.trim();
}

export async function translate(ai, q, src, tgt) {
  q = String(q || "").slice(0, 1000);
  if (!q.trim()) return { t: "" };
  if (!LANGS[src] || !LANGS[tgt]) throw new Error("bad language");
  if (src === tgt) return { t: q };
  let last;
  for (const m of LLMS) {
    try { return { t: await viaLLM(ai, m, q, src, tgt), m }; } catch (e) { last = e; }
  }
  try { return { t: await viaMT(ai, q, src, tgt), m: MT }; } catch (e) { last = e; }
  const msg = String((last && last.message) || last || "");
  return { error: /limit|quota|neuron|429|capacity/i.test(msg) ? "limit" : "fail", detail: msg.slice(0, 200) };
}
