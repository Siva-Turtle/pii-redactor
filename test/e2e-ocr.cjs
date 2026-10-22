// OCR end-to-end (pattern of test/e2e.cjs): standalone pictures, a scanned
// PDF, a text PDF with an embedded picture, and a .docx with a picture.
// Run: node test/e2e-ocr.cjs http://localhost:8731/
// Every fixture holds the same invented identity (Rohan Mehta, PAN
// QWERT1234Y, +91 98111 22233, rohan.mehta@example.com). Each output must
// have black pixels over every fixture word and its own OCR must no longer
// read any of the PII back.
const { chromium } = require(process.env.PW || "playwright");
const fs = require("fs"), path = require("path"), assert = require("assert");
let url = process.argv[2] || "http://localhost:8731/";
const NOAI = process.env.NOAI === "1";
if (NOAI) url += (url.includes("?") ? "&" : "?") + "noai=1"; // test-only hook (see js/app.js)
const fx = path.join(__dirname, "fixtures"), out = path.join(__dirname, "out");
const names = ["ocr-doc.png", "ocr-doc.jpg", "scanned.pdf", "textimage.pdf", "formimage.pdf", "picture.docx"];
const PII = ["QWERT1234Y", "98111 22233", "rohan.mehta@example.com"];
// The fixture name hides only when the AI runs (no cue/title in NOAI mode).
if (!NOAI) PII.push("Rohan Mehta");
const norm = (s) => String(s || "").replace(/\s+/g, "");
const ocrExpected = JSON.parse(fs.readFileSync(path.join(fx, "ocr-doc.expected.json"), "utf8"));
const pdfExpected = JSON.parse(fs.readFileSync(path.join(fx, "textimage.expected.json"), "utf8"));
const b64 = (n) => fs.readFileSync(path.join(fx, n)).toString("base64");

(async () => {
  const b = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const p = await b.newPage({ viewport: { width: 900, height: 1100 } });
  const requests = [];
  p.on("request", (r) => { if (!r.url().startsWith("http://localhost") && !r.url().startsWith("blob:")) requests.push(r.url()); });
  p.on("console", (m) => { if (m.type() === "error") console.log("console", m.type(), m.text().slice(0, 300)); });
  p.on("pageerror", (e) => console.log("pageerror:", e.message.slice(0, 500)));
  await p.goto(url);
  await p.waitForFunction(() => window.__appLoaded === true, null, { timeout: 60000 });

  // Pure OCR timing on the fixture picture (worker cold start included).
  const probe = await p.evaluate(async ({ b64 }) => {
    const ocr = await import("/js/ocr.js");
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const t0 = performance.now();
    const r = await ocr.ocrCanvas(bmp);
    const seconds = (performance.now() - t0) / 1000;
    bmp.close();
    return { text: r.text, seconds, nwords: r.words.length };
  }, { b64: b64("ocr-doc.png") });
  console.log(`probe: ${probe.nwords} words in ${probe.seconds.toFixed(1)}s`);
  for (const s of ["Rohan Mehta", "QWERT1234Y", "98111 22233", "rohan.mehta@example.com"]) {
    assert.ok(probe.text.includes(s), `fixture OCR reads ${s}`);
  }

  await p.setInputFiles("#picker", names.map((n) => path.join(fx, n)));
  await p.click("#removeBtn");
  await p.waitForFunction((n) => [...document.querySelectorAll(".frow .chip")].filter((s) => s.dataset.state === "done").length === n, names.length, { timeout: 600000 });
  console.log("all redacted:", await p.$$eval(".frow .chip", (els) => els.map((e) => e.textContent).join(",")));

  // Report: every file has (OCR) rows; the text PDF also keeps text-layer rows.
  await p.click("#ident summary");
  const repHref = await p.$eval("#repDl", (e) => e.href);
  const csvText = Buffer.from(await p.evaluate(async (h) => {
    const buf = new Uint8Array(await (await fetch(h)).arrayBuffer());
    let s = "";
    for (const x of buf) s += String.fromCharCode(x);
    return btoa(s);
  }, repHref), "base64").toString("utf8");
  const rows = csvText.replace(/^﻿/, "").split("\r\n").filter((l) => l && !l.startsWith("#")).slice(1);
  // NOTE: location cells are CSV-quoted when they hold a comma, so match on
  // the whole row, not on a naive comma split.
  const has = (f, re) => rows.some((r) => r.startsWith(f + ",") && re.test(r));
  assert.ok(has("ocr-doc.png", /image \(OCR\)/), "png rows tagged image (OCR)");
  assert.ok(has("ocr-doc.jpg", /image \(OCR\)/), "jpg rows tagged image (OCR)");
  assert.ok(has("scanned.pdf", /page 1, picture \(OCR\)/), "scanned.pdf rows tagged page 1, picture (OCR)");
  assert.ok(has("textimage.pdf", /picture \(OCR\)/), "textimage.pdf has picture (OCR) rows");
  assert.ok(has("textimage.pdf", /page 1, line/), "textimage.pdf keeps text-layer rows");
  assert.ok(has("formimage.pdf", /page 1, picture \(OCR\)/), "formimage.pdf (Form XObject) has picture rows");
  assert.ok(has("picture.docx", /picture 1 \(OCR\)/), "docx rows tagged picture 1 (OCR)");
  assert.ok(has("picture.docx", /paragraph/), "docx keeps paragraph rows");

  console.log("warnings:", await p.$$eval("#warns li", (els) => els.map((e) => e.textContent)));
  const warns = await p.$$eval("#warns li", (els) => els.map((e) => e.textContent).join(" "));
  assert.ok(/picture/.test(warns), "warnings mention the checked pictures");

  // Downloads: one ZIP with all five redacted files.
  const [dl] = await Promise.all([p.waitForEvent("download", { timeout: 60000 }), p.click("#dlBtn")]);
  assert.strictEqual(dl.suggestedFilename(), "pii-removed-files.zip", "zip name");
  const zipBuf = fs.readFileSync(await dl.path());
  fs.writeFileSync(path.join(out, "ocr-files.zip"), zipBuf);

  // In-page checks: dark fraction inside each fixture word box (a burned box
  // reads ~1, plain ink ~0.1-0.4) + OCR of the output finds no PII.
  const checkImage = (data, words, W, H) => p.evaluate(async ({ data, words, W, H }) => {
    const ocr = await import("/js/ocr.js");
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes]));
    const canvas = document.createElement("canvas");
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const frac = (box) => {
      const x0 = Math.max(0, Math.floor(box[0] * canvas.width / W) + 1);
      const y0 = Math.max(0, Math.floor(box[1] * canvas.height / H) + 1);
      const x1 = Math.min(canvas.width, Math.ceil(box[2] * canvas.width / W) - 1);
      const y1 = Math.min(canvas.height, Math.ceil(box[3] * canvas.height / H) - 1);
      let dark = 0, n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        n++;
        const i = (y * canvas.width + x) * 4;
        if (img.data[i] < 90 && img.data[i + 1] < 90 && img.data[i + 2] < 90) dark++;
      }
      return n ? dark / n : 0;
    };
    const scored = words.map((w) => ({ text: w.text, pii: !!w.pii, f: +frac(w.box).toFixed(3) }));
    const bad = scored.filter((s) => s.pii && s.f < 0.85).map((s) => s.text);
    const t0 = performance.now();
    const r = await ocr.ocrCanvas(canvas);
    return { scored, bad, ocrText: r.text, seconds: (performance.now() - t0) / 1000, w: canvas.width, h: canvas.height };
  }, { data, words, W, H });

  const checkPdf = (data, S, region, words) => p.evaluate(async ({ data, S, region, words }) => {
    const lib = await import("/vendor/pdfjs/pdf.min.mjs");
    lib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.mjs";
    const ocr = await import("/js/ocr.js");
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const doc = await lib.getDocument({ data: bytes, isEvalSupported: false }).promise;
    const page = await doc.getPage(1);
    const vp = page.getViewport({ scale: S });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const pages = doc.numPages;
    await doc.destroy();
    const d = ctx.getImageData(region.x, region.y, region.w, region.h).data;
    let dark = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { n++; if (d[i] < 90 && d[i + 1] < 90 && d[i + 2] < 90) dark++; }
    const full = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const frac = (box) => {
      const x0 = Math.max(0, Math.floor(box[0]) + 1);
      const y0 = Math.max(0, Math.floor(box[1]) + 1);
      const x1 = Math.min(canvas.width, Math.ceil(box[2]) - 1);
      const y1 = Math.min(canvas.height, Math.ceil(box[3]) - 1);
      let dk = 0, m = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        m++;
        const i = (y * canvas.width + x) * 4;
        if (full.data[i] < 90 && full.data[i + 1] < 90 && full.data[i + 2] < 90) dk++;
      }
      return m ? dk / m : 0;
    };
    const scored = (words || []).map((w) => ({ text: w.text, pii: !!w.pii, f: +frac(w.box).toFixed(3) }));
    const bad = scored.filter((s) => s.pii && s.f < 0.85).map((s) => s.text);
    const t0 = performance.now();
    const r = await ocr.ocrCanvas(canvas);
    return { darkFraction: dark / n, scored, bad, ocrText: r.text, seconds: (performance.now() - t0) / 1000, pages, w: canvas.width, h: canvas.height };
  }, { data, S, region, words });

  const JSZIP = require(path.join(__dirname, "..", "tools", "node_modules", "jszip"));
  const zip = await JSZIP.loadAsync(zipBuf);
  const entryB64 = async (n) => Buffer.from(await zip.file(n).async("uint8array")).toString("base64");
  const znames = Object.keys(zip.files);
  console.log("zip entries:", JSON.stringify(znames));

  const assertClean = (label, ocrText) => {
    for (const s of PII) assert.ok(!norm(ocrText).includes(norm(s)), `${label}: output OCR still reads ${s}: ${ocrText.slice(0, 120)}`);
  };

  // 1-2. standalone images: same pixel size in and out, exact word centres.
  for (const [fileName, zipName] of [["ocr-doc.png", "ocr-doc.redacted.png"], ["ocr-doc.jpg", "ocr-doc.redacted.jpg"]]) {
    assert.ok(znames.includes(zipName), `zip holds ${zipName}`);
    const r = await checkImage(await entryB64(zipName), ocrExpected.words, ocrExpected.width, ocrExpected.height);
    console.log(`${zipName}: ${r.w}x${r.h}, OCR ${r.seconds.toFixed(1)}s, uncovered: ${JSON.stringify(r.bad)}`);
    console.log("  word fractions:", JSON.stringify(r.scored));
    assert.deepStrictEqual(r.bad, [], `${zipName}: every fixture word centre is black`);
    assertClean(zipName, r.ocrText);
  }

  // 3. scanned.pdf: full-bleed picture, output render maps 1:1 at scale 2.
  {
    assert.ok(znames.includes("scanned.redacted.pdf"));
    const S = 2, PW_PT = 800, PH_PT = 500;
    const sx = (PW_PT * S) / ocrExpected.width, sy = (PH_PT * S) / ocrExpected.height;
    const words = ocrExpected.words.map((w) => ({
      text: w.text,
      pii: w.pii,
      box: [w.box[0] * sx, w.box[1] * sy, w.box[2] * sx, w.box[3] * sy],
    }));
    const r = await checkPdf(await entryB64("scanned.redacted.pdf"), S, { x: 0, y: 0, w: PW_PT * S, h: PH_PT * S }, words);
    console.log(`scanned.redacted.pdf: ${r.w}x${r.h}, dark ${(100 * r.darkFraction).toFixed(1)}%, OCR ${r.seconds.toFixed(1)}s`);
    console.log("  word fractions:", JSON.stringify(r.scored));
    assert.strictEqual(r.pages, 2, "redacted pdf + notice page");
    assert.deepStrictEqual(r.bad, [], "every fixture word centre is black");
    assert.ok(r.darkFraction > 0.01, "boxes were burned into the page");
    assertClean("scanned.redacted.pdf", r.ocrText);
  }

  // 4. text PDFs with embedded pictures: direct image and Form-XObject image
  // share the same draw rect, so they share the same pixel expectations.
  for (const zipName of ["textimage.redacted.pdf", "formimage.redacted.pdf"]) {
    assert.ok(znames.includes(zipName), `zip holds ${zipName}`);
    const S = 2, { draw, page } = pdfExpected;
    const kx = (draw.w * S) / pdfExpected.img.w, ky = (draw.h * S) / pdfExpected.img.h;
    const region = { x: Math.round(draw.x * S), y: Math.round((page.h - draw.y - draw.h) * S), w: Math.round(draw.w * S), h: Math.round(draw.h * S) };
    const words = pdfExpected.words.map((w) => ({
      text: w.text,
      pii: w.pii,
      box: [region.x + w.box[0] * kx, region.y + w.box[1] * ky, region.x + w.box[2] * kx, region.y + w.box[3] * ky],
    }));
    const r = await checkPdf(await entryB64(zipName), S, region, words);
    console.log(`${zipName}: dark ${(100 * r.darkFraction).toFixed(1)}%, OCR ${r.seconds.toFixed(1)}s`);
    console.log("  word fractions:", JSON.stringify(r.scored));
    assert.deepStrictEqual(r.bad, [], `${zipName}: every embedded word centre is black`);
    assert.ok(r.darkFraction > 0.01, `${zipName}: boxes were burned into the embedded picture`);
    assertClean(zipName, r.ocrText);
  }

  // 5. picture.docx: media bytes keep their pixel size; text paragraph redacted too.
  {
    assert.ok(znames.includes("picture.redacted.docx"));
    const r = await p.evaluate(async ({ data, words, W, H }) => {
      const ocr = await import("/js/ocr.js");
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const zip = await JSZip.loadAsync(bytes);
      const media = Object.keys(zip.files).find((n) => /^word\/media\/[^/]+$/.test(n) && !zip.files[n].dir);
      const png = await zip.file(media).async("uint8array");
      const bmp = await createImageBitmap(new Blob([png]));
      const canvas = document.createElement("canvas");
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      bmp.close();
      const d = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const frac = (box) => {
        const x0 = Math.max(0, Math.floor(box[0] * canvas.width / W) + 1);
        const y0 = Math.max(0, Math.floor(box[1] * canvas.height / H) + 1);
        const x1 = Math.min(canvas.width, Math.ceil(box[2] * canvas.width / W) - 1);
        const y1 = Math.min(canvas.height, Math.ceil(box[3] * canvas.height / H) - 1);
        let dk = 0, m = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
          m++;
          const i = (y * canvas.width + x) * 4;
          if (d.data[i] < 90 && d.data[i + 1] < 90 && d.data[i + 2] < 90) dk++;
        }
        return m ? dk / m : 0;
      };
      const scored = words.map((w) => ({ text: w.text, pii: !!w.pii, f: +frac(w.box).toFixed(3) }));
      const bad = scored.filter((s) => s.pii && s.f < 0.85).map((s) => s.text);
      const docXml = await zip.file("word/document.xml").async("string");
      const t0 = performance.now();
      const ocrText = (await ocr.ocrCanvas(canvas)).text;
      return { media, scored, bad, ocrText, seconds: (performance.now() - t0) / 1000, docHasEmail: docXml.includes("rohan.mehta@example.com") };
    }, { data: await entryB64("picture.redacted.docx"), words: ocrExpected.words, W: ocrExpected.width, H: ocrExpected.height });
    console.log(`picture.redacted.docx: media=${r.media}, OCR ${r.seconds.toFixed(1)}s, uncovered: ${JSON.stringify(r.bad)}`);
    console.log("  word fractions:", JSON.stringify(r.scored));
    assert.ok(/\.png$/.test(r.media), "picture written back under the same name");
    assert.deepStrictEqual(r.bad, [], "every picture word centre is black");
    assertClean("picture media", r.ocrText);
    assert.strictEqual(r.docHasEmail, false, "text paragraph email redacted");
  }

  console.log("\nexternal requests:", JSON.stringify(requests));
  assert.strictEqual(requests.length, 0, "no network at runtime (OCR is vendored)");
  await b.close();
  console.log("E2E-OCR PASSED");
})().catch((e) => { console.error("E2E-OCR FAILED:", e); process.exit(1); });
