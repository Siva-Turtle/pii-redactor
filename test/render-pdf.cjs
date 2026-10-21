const { chromium } = require(process.env.PW || "playwright");
(async () => {
  const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const p = await b.newPage({ viewport: { width: 820, height: 560 } });
  await p.goto("http://localhost:8765/");
  const res = await p.evaluate(async (f) => {
    const lib = await import("/vendor/pdfjs/pdf.min.mjs");
    lib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.mjs";
    const doc = await lib.getDocument({ url: f, isEvalSupported: false }).promise;
    const page = await doc.getPage(1);
    const text = (await page.getTextContent()).items.length;
    const vp = page.getViewport({ scale: 1.2 });
    const c = document.createElement("canvas"); c.width = vp.width; c.height = vp.height / 2.2 | 0;
    document.body.replaceChildren(c);
    await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
    return { pages: doc.numPages, textItems: text };
  }, "/test/out/sample.redacted.pdf");
  console.log(JSON.stringify(res));
  await p.screenshot({ path: "/home/user/pii-redactor/test/out/pdf.png" });
  await b.close();
})();
