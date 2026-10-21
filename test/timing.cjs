const { chromium } = require(process.env.PW || "playwright");
const path = require("path");
(async () => {
  const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const p = await b.newPage();
  p.on("pageerror", (e) => console.log("pageerror:", e.message));
  await p.goto("http://localhost:8731/");
  const r = await p.evaluate(async () => {
    const { loadDetector } = await import("/js/ai.js");
    const { Redactor } = await import("/js/redactor.js");
    const d = await loadDetector();
    const log = [];
    const spy = { find: async (k, t, v) => { const r = await d.find(k, t, v); log.push([k, v, t.slice(0, 60), r]); return r; } };
    const red = new Redactor({ detector: spy });
    const text = await (await fetch("/test/fixtures/finance.txt")).text();
    const t0 = performance.now();
    const res = await red.learn([text]);
    return { ms: Math.round(performance.now() - t0), res, calls: log.length, out: red.apply(text), generic: log.filter((l) => l[0] === "pii").map((l) => l.slice(1)) };
  });
  console.log(JSON.stringify({ ms: r.ms, res: r.res, calls: r.calls }));
  console.log(r.out);
  console.log("--- generic find_pii calls (variant, text, answer):");
  for (const g of r.generic) console.log(JSON.stringify(g));
  await b.close();
})();
