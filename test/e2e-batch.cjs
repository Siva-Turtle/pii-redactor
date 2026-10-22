// Batch e2e (step 5): file A labels a name/ID, file B repeats them bare.
// B must hide the bare repeats via the batch-wide PII list.
// Run: node test/e2e-batch.cjs http://localhost:8731/   (NOAI=1 supported)
const { chromium } = require(process.env.PW || "playwright");
const fs = require("fs"), path = require("path"), assert = require("assert");
let url = process.argv[2] || "http://localhost:8731/";
const NOAI = process.env.NOAI === "1";
if (NOAI) url += (url.includes("?") ? "&" : "?") + "noai=1";
const fx = path.join(__dirname, "fixtures"), out = path.join(__dirname, "out");
const names = ["batch-a.txt", "batch-b.txt"];

(async () => {
  const b = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const p = await b.newPage({ viewport: { width: 900, height: 1100 } });
  p.on("pageerror", (e) => console.log("pageerror:", e.message.slice(0, 300)));
  await p.goto(url);
  await p.waitForFunction(() => window.__appLoaded === true, null, { timeout: 60000 });
  await p.setInputFiles("#picker", names.map((n) => path.join(fx, n)));
  await p.click("#removeBtn");
  await p.waitForFunction(() => [...document.querySelectorAll(".frow .chip")].every((s) => ["done", "error"].includes(s.dataset.state)), null, { timeout: 900000 });
  const chips = await p.$$eval(".frow .chip", (els) => els.map((e) => e.textContent));
  console.log("chips:", JSON.stringify(chips));
  assert.deepStrictEqual(chips, ["Done", "Done"]);
  // Progress named both passes.
  // Report must carry batch-wide rows for file B.
  await p.click("#ident summary");
  const repHref = await p.$eval("#repDl", (e) => e.href);
  const csvText = Buffer.from(await p.evaluate(async (h) => {
    const buf = new Uint8Array(await (await fetch(h)).arrayBuffer());
    let s = "";
    for (const x of buf) s += String.fromCharCode(x);
    return btoa(s);
  }, repHref), "base64").toString("utf8");
  fs.writeFileSync(path.join(out, "batch-report.csv"), csvText);
  const rows = csvText.replace(/^﻿/, "").split("\r\n").filter((l) => l && !l.startsWith("#")).slice(1);
  const inB = rows.filter((r) => r.startsWith("batch-b.txt,"));
  console.log(`report rows: ${rows.length} total, ${inB.length} for batch-b.txt`);
  assert.ok(inB.some((r) => r.includes("Anita Desai")), "batch B report hides the bare name");
  assert.ok(inB.some((r) => r.includes("99887766")), "batch B report hides the bare ID");
  // Downloads: ZIP with both redacted files; B carries no bare PII.
  const [dl] = await Promise.all([p.waitForEvent("download", { timeout: 60000 }), p.click("#dlBtn")]);
  assert.strictEqual(dl.suggestedFilename(), "pii-removed-files.zip", "zip name");
  const JSZIP = require(path.join(__dirname, "..", "tools", "node_modules", "jszip"));
  const zip = await JSZIP.loadAsync(fs.readFileSync(await dl.path()));
  const bText = await zip.file("batch-b.redacted.txt").async("string");
  console.log("batch-b redacted:\n" + bText.split("\n").slice(0, 6).join("\n"));
  assert.ok(!bText.includes("Anita Desai"), "bare name hidden in B");
  assert.ok(!bText.includes("99887766"), "bare ID hidden in B");
  assert.ok(!bText.includes("anita.desai@example.com"), "bare email hidden in B");
  await b.close();
  console.log("E2E-BATCH PASSED");
})().catch((e) => { console.error("E2E-BATCH FAILED:", e); process.exit(1); });
