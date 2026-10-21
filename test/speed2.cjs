const { chromium } = require(process.env.PW || "playwright");
(async () => {
  const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const p = await b.newPage();
  await p.goto("http://localhost:8731/");
  const r = await p.evaluate(async () => {
    const { loadDetector } = await import("/js/ai.js");
    const d = await loadDetector(undefined, 1);
    const base = "Kindly credit my SBI savings account and send the statement to the office. ";
    const mk = (n) => (base.repeat(4)).slice(0, n);
    const out = [];
    for (const n of [40, 80, 160, 240]) {
      const t = mk(n); const t0 = performance.now();
      for (let i = 0; i < 3; i++) await d.find("pii", t, 0);
      out.push(["no-answer len " + n, Math.round((performance.now() - t0) / 3)]);
    }
    for (const t of ["Contact Priya Nair.", "Contact Priya Nair at Flat 12B, Sunrise Apartments, Andheri West, Mumbai 400053 today please."]) {
      const t0 = performance.now(); let a; for (let i = 0; i < 3; i++) a = await d.find("pii", t, 0);
      out.push(["with answer len " + t.length + " -> " + a, Math.round((performance.now() - t0) / 3)]);
    }
    return out;
  });
  for (const x of r) console.log(x.join("  ms="));
  await b.close();
})();
