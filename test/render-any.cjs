const { chromium } = require(process.env.PW || "playwright");
(async () => {
  const b = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const p = await b.newPage({ viewport: { width: 900, height: 480 } });
  await p.goto("http://localhost:8731/");
  await p.evaluate(async (f) => {
    const lib = await import("/vendor/pdfjs/pdf.min.mjs");
    lib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.mjs";
    const doc = await lib.getDocument({ url: f, isEvalSupported: false }).promise;
    document.body.replaceChildren(); document.body.style.cssText = "display:flex;gap:12px;background:#ccc";
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i); const vp = page.getViewport({ scale: 1 });
      const c = document.createElement("canvas"); c.width = vp.width; c.height = vp.height; document.body.append(c);
      await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
    }
  }, process.argv[2]);
  await p.screenshot({ path: process.argv[3] });
  await b.close();
})();
