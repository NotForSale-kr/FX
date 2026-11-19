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

// 단어 뜻: 단어 + 그 단어가 쓰인 문장을 주면, 문장 속 뜻과 다른 뜻을 한국어로
const WORD_RE = /^[\p{L}][\p{L}'’\-]{0,39}$/u;

export function parseDef(s) {
  const lines = clean(s).split(/\n+/)
    .map((l) => l.replace(/\*\*/g, "").replace(/^\s*(?:\d[.)]|[-*•]|[①②③])\s*/, "").replace(/^\s*(?:기본형|문장 속 뜻|다른 뜻|뜻)\s*[:：]\s*/, "").trim())
    .filter(Boolean);
  if (lines.length < 2) throw new Error("format");
  const m = lines[0].match(/^(.+?)\s*[\[(（]\s*([^\])）]+?)\s*[\])）]\s*$/);
  const more = lines[2] && !/^(-|–|없음|none)$/i.test(lines[2]) ? lines[2] : "";
  return { base: (m ? m[1] : lines[0]).trim(), pos: m ? m[2].trim() : "", mean: lines[1], more };
}

export async function define(ai, w, ctx, lang) {
  w = String(w || "").trim().replace(/^['’\-]+|['’\-]+$/g, "");
  ctx = String(ctx || "").slice(0, 300);
  if (!WORD_RE.test(w)) throw new Error("bad word");
  if (!LANGS[lang] || lang === "ko") throw new Error("bad language");
  let last;
  for (const model of LLMS) {
    try {
      const out = await ai.run(model, {
        messages: [
          { role: "system", content: `You are a concise ${LANGS[lang]}-Korean dictionary. The user gives a ${LANGS[lang]} word and the sentence it was used in. Answer in exactly 3 lines and nothing else:\n1) the dictionary (base) form of the word, then its part of speech in Korean in square brackets, e.g. run [동사]\n2) its Korean meaning as used in this sentence (short)\n3) up to 3 other common Korean meanings, comma-separated, or - if none` },
          { role: "user", content: `Word: ${w}\nSentence: ${ctx || w}` },
        ],
        temperature: 0.1,
        max_tokens: 120,
      });
      const t = out && (out.response ?? (out.choices && out.choices[0] && out.choices[0].message && out.choices[0].message.content));
      return { w, ...parseDef(t), m: model };
    } catch (e) { last = e; }
  }
  try { return { w, base: w, pos: "", mean: await viaMT(ai, w, lang, "ko"), more: "", m: MT }; } catch (e) { last = e; }
  const msg = String((last && last.message) || last || "");
  return { error: /limit|quota|neuron|429|capacity/i.test(msg) ? "limit" : "fail", detail: msg.slice(0, 200) };
}
