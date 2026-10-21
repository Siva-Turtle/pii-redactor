// Verifies the redacted mixed.pdf: every known PII extent must be (nearly) solid black.
const { chromium } = require(process.env.PW || "playwright");
const fs = require("fs"), path = require("path");
(async () => {
  const expected = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/mixed.expected.json")));
  const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const p = await b.newPage();
  await p.goto("http://localhost:8731/");
  const res = await p.evaluate(async ({ f, expected }) => {
    const lib = await import("/vendor/pdfjs/pdf.min.mjs");
    lib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.mjs";
    const doc = await lib.getDocument({ url: f, isEvalSupported: false }).promise;
    const page = await doc.getPage(1);
    const S = 3, vp = page.getViewport({ scale: S });
    const c = document.createElement("canvas"); c.width = vp.width; c.height = vp.height;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    return expected.map((e) => {
      const x = Math.floor(e.x0 * S), w = Math.ceil((e.x1 - e.x0) * S), y = Math.floor(e.top * S), h = Math.ceil((e.bottom - e.top) * S);
      const d = ctx.getImageData(x, y, w, h).data; let dark = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) { n++; if (d[i] < 90 && d[i + 1] < 90 && d[i + 2] < 90) dark++; }
      return { pii: e.pii, coverage: +(dark / n).toFixed(4) };
    });
  }, { f: "/test/out/mixed.redacted.pdf", expected });
  let bad = 0;
  for (const r of res) { console.log(r.coverage >= 0.995 ? "OK  " : "FAIL", r.coverage, r.pii); if (r.coverage < 0.995) bad++; }
  await b.close(); process.exit(bad ? 1 : 0);
})();
