const { chromium } = require(process.env.PW || "playwright");
const path = require("path"), fs = require("fs");
const JSZip = require(path.join(__dirname, "..", "tools", "node_modules", "jszip"));
(async () => {
  const b = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  // 1. ZIP of files with the same name (deduped entries, reports excluded)
  const p = await b.newPage({ acceptDownloads: true });
  p.on("pageerror", (e) => console.log("pageerror:", e.message));
  await p.goto("http://localhost:8731/?noai=1");
  await p.setInputFiles("#picker", [path.join(__dirname, "fixtures/sample.txt"), path.join(__dirname, "out/dup/sample.txt"), path.join(__dirname, "fixtures/sample.csv")]);
  await p.click("#removeBtn");
  await p.waitForFunction(() => [...document.querySelectorAll(".frow .chip")].filter((s) => s.dataset.state === "done").length === 3, null, { timeout: 120000 });
  const [dl] = await Promise.all([p.waitForEvent("download"), p.click("#dlBtn")]);
  console.log("download:", dl.suggestedFilename());
  const zip = await JSZip.loadAsync(fs.readFileSync(await dl.path()));
  console.log("zip entries:", Object.keys(zip.files).sort().join(" | "));
  // Choosing a new set replaces the old one and clears old results
  await p.setInputFiles("#picker", [path.join(__dirname, "fixtures/sample.txt")]);
  console.log("after reselect: rows =", await p.$$eval(".frow", (e) => e.length), "| status =", await p.textContent("#status"));
  // 2. file:// shows the friendly banner and does not throw
  const q = await b.newPage();
  const errs = []; q.on("pageerror", (e) => errs.push(e.message));
  await q.goto(`file://${path.join(__dirname, "..", "index.html")}`);
  await q.waitForTimeout(800);
  console.log("file:// banner:", (await q.textContent("#banner")).slice(0, 90), "| page errors:", JSON.stringify(errs));
  await b.close();
})();
