// 주식 시세 중계 서버 (Cloudflare Worker)
// 앱 → 이 서버 → 네이버(국내)·야후(미국) → 한 번에 묶어서 앱으로 돌려줌
//   GET /?kr=005930,000660&idx=KOSPI,KOSDAQ&us=AAPL,^IXIC
//   GET /search?q=삼성

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};
const UA = {
  "User-Agent": "Mozilla/5.0 (Linux; Android 15; SM-S928N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36",
  "Accept": "application/json,text/plain,*/*",
};

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: CORS });
const num = (s) => (typeof s === "number" ? s : parseFloat(String(s ?? "").replace(/,/g, "")));
const list = (s, re, max) => (s || "").split(",").map((x) => x.trim()).filter((x) => re.test(x)).slice(0, max);

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
    q[d.itemCode || d.symbolCode] = {
      n: d.stockName || d.indexName || "",
      p: num(d.closePrice), c, r,
      open: d.marketStatus === "OPEN",
    };
  }
}

// 미국 종목·지수: 야후 차트
async function yahoo(sym, q) {
  const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1d`);
  const m = j.chart.result[0].meta;
  const p = m.regularMarketPrice, pc = m.chartPreviousClose ?? m.previousClose;
  q[sym] = { n: m.shortName || "", p, c: p - pc, r: (p / pc - 1) * 100, usd: true };
}

async function quotes(sp) {
  const kr = list(sp.get("kr"), /^\d[0-9A-Z]{5}$/, 40);
  const idx = list(sp.get("idx"), /^(KOSPI|KOSDAQ|KPI200)$/, 3);
  const us = list(sp.get("us"), /^[\^A-Z][A-Z0-9.\-=^]{0,11}$/, 40);
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

export default {
  async fetch(req) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    try {
      if (url.pathname === "/search") return json(await search(url.searchParams.get("q") || ""));
      return json(await quotes(url.searchParams));
    } catch (e) {
      return json({ error: String(e.message || e) }, 502);
    }
  },
};
