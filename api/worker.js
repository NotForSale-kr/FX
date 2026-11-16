// 주식 시세 중계 서버 + 등락 알림 (Cloudflare Worker)
//   GET  /?kr=005930,000660&idx=KOSPI,KOSDAQ&us=AAPL,^IXIC   시세 묶음
//   GET  /search?q=삼성                                      종목 검색
//   GET  /vapid                                             알림용 공개키
//   POST /sub   {sub, list, names, th, welcome}             알림 켜기·종목 갱신
//   POST /unsub {endpoint}                                  알림 끄기
//   (1분마다) 장중에 관심종목이 전일 종가 대비 ±th% 넘으면 푸시 — 종목·방향별 하루 한 번

import { genVapid, sendPush } from "./push.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};
const UA = {
  "User-Agent": "Mozilla/5.0 (Linux; Android 15; SM-S928N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36",
  "Accept": "application/json,text/plain,*/*",
};
const SUBJECT = "https://notforsale-kr.github.io";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: CORS });
const num = (s) => (typeof s === "number" ? s : parseFloat(String(s ?? "").replace(/,/g, "")));
const list = (s, re, max) => (s || "").split(",").map((x) => x.trim()).filter((x) => re.test(x)).slice(0, max);
const KR_RE = /^\d[0-9A-Z]{5}$/, US_RE = /^[\^A-Z][A-Z0-9.\-=^]{0,11}$/;

async function getJSON(url) {
  const r = await fetch(url, { headers: UA, cf: { cacheTtl: 5 } });
  if (!r.ok) throw new Error(url.split("/")[2] + " " + r.status);
  return r.json();
}

// 국내 종목·지수: 네이버 실시간
async function naver(kind, codes, q) {
  if (!codes.length) return;
  const j = await getJSON(`https://polling.finance.naver.com/api/realtime/domestic/${kind}/${codes.join(",")}`);
  for (const d of j.datas || []) {
    let c = num(d.compareToPreviousClosePrice), r = num(d.fluctuationsRatio);
    const dir = (d.compareToPreviousPrice && d.compareToPreviousPrice.code) || "";
    if ((dir === "4" || dir === "5") && c > 0) c = -c;      // 하한·하락
    if ((dir === "4" || dir === "5") && r > 0) r = -r;
    q[d.itemCode || d.symbolCode] = { n: d.stockName || d.indexName || "", p: num(d.closePrice), c, r, open: d.marketStatus === "OPEN" };
  }
}

// 미국 종목·지수: 야후 차트
async function yahoo(sym, q) {
  const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1d`);
  const m = j.chart.result[0].meta;
  const p = m.regularMarketPrice, pc = m.chartPreviousClose ?? m.previousClose;
  const reg = (m.currentTradingPeriod && m.currentTradingPeriod.regular) || {};
  const now = Date.now() / 1000;
  const open = reg.start <= now && now <= reg.end + 300 && m.regularMarketTime >= reg.start;
  q[sym] = { n: m.shortName || "", p, c: p - pc, r: (p / pc - 1) * 100, usd: true, open };
}

async function quotes(sp) {
  const kr = list(sp.get("kr"), KR_RE, 40);
  const idx = list(sp.get("idx"), /^(KOSPI|KOSDAQ|KPI200)$/, 3);
  const us = list(sp.get("us"), US_RE, 40);
  const q = {}, err = {};
  await Promise.all([
    naver("stock", kr, q).catch((e) => (err.kr = String(e.message || e))),
    naver("index", idx, q).catch((e) => (err.kr = err.kr || String(e.message || e))),
    ...us.map((s) => yahoo(s, q).catch((e) => (err.us = err.us || []).push(s + ": " + String(e.message || e)))),
  ]);
  return { t: Date.now(), q, err };
}

// 종목 검색: 네이버 자동완성 (국내 + 미국)
async function search(text) {
  text = text.trim().slice(0, 30);
  if (!text) return { items: [] };
  const j = await getJSON(`https://m.stock.naver.com/front-api/search/autoComplete?query=${encodeURIComponent(text)}&target=stock`);
  const raw = (j.result && j.result.items) || j.items || [];
  const items = raw
    .filter((x) => x.nationCode === "KOR" || x.nationCode === "USA")
    .map((x) => ({ n: x.name, c: x.code, m: x.typeName || x.nationName || "", us: x.nationCode === "USA" }))
    .slice(0, 10);
  return { items };
}

// 한국 시간 기준 장 시간대 (휴장일은 시세의 장 상태로 한 번 더 거름)
export function windows(now = new Date()) {
  const k = new Date(now.getTime() + 9 * 3600e3), day = k.getUTCDay(), hm = k.getUTCHours() * 60 + k.getUTCMinutes();
  return {
    kr: day >= 1 && day <= 5 && hm >= 9 * 60 && hm <= 15 * 60 + 35,
    us: (day >= 1 && day <= 5 && hm >= 22 * 60 + 30) || (day >= 2 && day <= 6 && hm <= 6 * 60 + 5),
  };
}

const sha = async (s) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))]
  .slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");

function fmtLine(name, q) {
  const pct = (q.r > 0 ? "+" : "") + q.r.toFixed(2) + "%";
  const price = q.usd ? "$" + q.p.toFixed(2) : Math.round(q.p).toLocaleString("en-US") + "원";
  return `${q.r > 0 ? "▲" : "▼"} ${name} ${pct} · ${price}`;
}

// 구독 정보와 알림 기록을 저장하는 곳
export class Store {
  constructor(ctx, env) { this.s = ctx.storage; }

  async vapid() {
    let v = await this.s.get("vapid");
    if (!v) { v = await genVapid(); await this.s.put("vapid", v); }
    return v;
  }

  async fetch(req) {
    const url = new URL(req.url), path = url.pathname;
    if (path === "/vapid") return json({ key: (await this.vapid()).pub });
    if (path === "/check") return json(await this.check(url.searchParams.get("force") === "1"));
    const b = await req.json().catch(() => ({}));
    if (path === "/sub") {
      const sub = b.sub;
      if (!sub || !/^https:\/\//.test(sub.endpoint || "") || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return json({ error: "bad subscription" }, 400);
      const id = await sha(sub.endpoint);
      const codes = (Array.isArray(b.list) ? b.list : []).filter((c) => KR_RE.test(c) || US_RE.test(c)).slice(0, 40);
      const names = {};
      for (const c of codes) if (b.names && typeof b.names[c] === "string") names[c] = b.names[c].slice(0, 30);
      const th = Math.min(30, Math.max(0.5, num(b.th) || 1));
      const old = await this.s.get("sub:" + id);
      await this.s.put("sub:" + id, { sub: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }, list: codes, names, th, sent: (old && old.sent) || {} });
      let welcome = null;
      if (b.welcome) {
        welcome = await sendPush(sub, { title: "🔔 주식 알림이 켜졌어요", body: `관심종목이 전일 종가 대비 ±${th}% 움직이면 알려드릴게요`, tag: "welcome" }, await this.vapid(), SUBJECT).catch((e) => String(e));
      }
      return json({ ok: true, count: codes.length, welcome });
    }
    if (path === "/unsub") {
      if (b.endpoint) await this.s.delete("sub:" + (await sha(b.endpoint)));
      return json({ ok: true });
    }
    return json({ error: "not found" }, 404);
  }

  async check(force) {
    const w = windows();
    if (!force && !w.kr && !w.us) return { skipped: "market closed" };
    const subs = await this.s.list({ prefix: "sub:" });
    if (!subs.size) return { subs: 0 };
    const all = new Set();
    for (const v of subs.values()) v.list.forEach((c) => all.add(c));
    const kr = [...all].filter((c) => KR_RE.test(c) && (w.kr || force)).slice(0, 40);
    const us = [...all].filter((c) => !KR_RE.test(c) && (w.us || force)).slice(0, 30);
    const q = {};
    await Promise.all([naver("stock", kr, q).catch(() => 0), ...us.map((s) => yahoo(s, q).catch(() => 0))]);

    const vapid = await this.vapid(), today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
    let sent = 0;
    for (const [key, v] of subs) {
      if (sent >= 15) break;
      const lines = [];
      let changed = false;
      for (const k of Object.keys(v.sent)) if (!k.endsWith(today)) { delete v.sent[k]; changed = true; }   // 지난날 기록 정리
      for (const c of v.list) {
        const x = q[c];
        if (!x || !isFinite(x.r) || (!x.open && !force)) continue;
        const dir = x.r >= v.th ? "up" : x.r <= -v.th ? "down" : null;
        if (!dir) continue;
        const mark = `${c}:${dir}:${today}`;
        if (v.sent[mark]) continue;
        v.sent[mark] = 1;
        lines.push(fmtLine(v.names[c] || x.n || c, x));
      }
      if (!lines.length) { if (changed) await this.s.put(key, v); continue; }
      const data = lines.length === 1
        ? { title: lines[0].split(" · ")[0], body: "전일 종가 대비 · 현재 " + lines[0].split(" · ")[1], tag: "move" }
        : { title: `관심종목 ${lines.length}개가 ±${v.th}% 넘게 움직였어요`, body: lines.join("\n"), tag: "move" };
      const status = await sendPush(v.sub, data, vapid, SUBJECT).catch(() => 0);
      sent++;
      if (status === 404 || status === 410) await this.s.delete(key);
      else await this.s.put(key, v);
    }
    return { subs: subs.size, pushed: sent };
  }
}

const store = (env) => env.STORE.get(env.STORE.idFromName("main"));

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    try {
      if (url.pathname === "/search") return json(await search(url.searchParams.get("q") || ""));
      if (["/vapid", "/sub", "/unsub"].includes(url.pathname)) {
        const r = await store(env).fetch(new Request("https://store" + url.pathname, { method: req.method, body: req.method === "POST" ? await req.text() : undefined }));
        return new Response(r.body, { status: r.status, headers: CORS });
      }
      return json(await quotes(url.searchParams));
    } catch (e) {
      return json({ error: String(e.message || e) }, 502);
    }
  },

  async scheduled(event, env, ctx) {
    const w = windows();
    if (!w.kr && !w.us) return;                     // 장 시간 아니면 아무것도 안 함
    ctx.waitUntil(store(env).fetch("https://store/check"));
  },
};
