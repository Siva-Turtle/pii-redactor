const { chromium } = require(process.env.PW || "playwright");
const path = require("path");
(async () => {
  const b = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const p = await b.newPage();
  p.on("pageerror", (e) => console.log("pageerror:", e.message));
  await p.goto("http://localhost:8731/");
  const r = await p.evaluate(async () => {
    const { loadDetector } = await import("/js/ai.js");
    const { Redactor } = await import("/js/redactor.js");
    const d = await loadDetector();
    const log = [];
    const spans = [];
    const spy = { size: d.size, find: async (k, t, v) => { const a = performance.now(); const r = await d.find(k, t, v); spans.push([a, performance.now()]); log.push([k, v, t.slice(0, 60), r]); return r; } };
    const red = new Redactor({ detector: spy });
    const text = await (await fetch("/test/fixtures/finance.txt")).text();
    const t0 = performance.now();
    const res = await red.learn([text]);
    const ev = spans.flatMap(([a, b]) => [[a, 1], [b, -1]]).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    let cur = 0, max = 0; for (const [, dlt] of ev) { cur += dlt; max = Math.max(max, cur); }
    const avg = Math.round(spans.reduce((s, [a, b]) => s + (b - a), 0) / spans.length);
    return { size: d.size, maxConcurrent: max, avgCallMs: avg, ms: Math.round(performance.now() - t0), res, calls: log.length, out: red.apply(text), generic: log.filter((l) => /Password/.test(l[2]) || l[3] && /sunshine/.test(l[3])).map((l) => l) };
  });
  console.log(JSON.stringify({ size: r.size, maxConcurrent: r.maxConcurrent, avgCallMs: r.avgCallMs, ms: r.ms, res: r.res, calls: r.calls }));
  console.log(r.out);
  console.log("--- generic find_pii calls (variant, text, answer):");
  for (const g of r.generic) console.log(JSON.stringify(g));
  await b.close();
})();
