const { chromium } = require(process.env.PW || "playwright");
const path = require("path"), fs = require("fs");
const JSZip = require("/home/user/pii-redactor/tools/node_modules/jszip");
(async () => {
  const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  // 1. ZIP of two files with the same name
  const p = await b.newPage({ acceptDownloads: true });
  p.on("pageerror", (e) => console.log("pageerror:", e.message));
  await p.goto("http://localhost:8731/");
  await p.uncheck("#optAi");
  await p.setInputFiles("#picker", [path.join(__dirname, "fixtures/sample.txt"), path.join(__dirname, "out/dup/sample.txt"), path.join(__dirname, "fixtures/sample.csv")]);
  await p.waitForFunction(() => [...document.querySelectorAll(".file .state")].filter((s) => /^Done/.test(s.textContent)).length === 3, null, { timeout: 120000 });
  const [dl] = await Promise.all([p.waitForEvent("download"), p.click("#zipAll")]);
  const zip = await JSZip.loadAsync(fs.readFileSync(await dl.path()));
  console.log("zip entries:", Object.keys(zip.files).sort().join(" | "));
  // Start over clears everything
  await p.click("#reset");
  console.log("after reset: cards =", await p.$$eval(".file", (e) => e.length), "| actions hidden =", await p.$eval("#actions", (e) => e.hidden));
  // 2. file:// shows the friendly banner and does not throw
  const q = await b.newPage();
  const errs = []; q.on("pageerror", (e) => errs.push(e.message));
  await q.goto("file:///home/user/pii-redactor/index.html");
  await q.waitForTimeout(800);
  console.log("file:// banner:", (await q.textContent("#banner")).slice(0, 90), "| page errors:", JSON.stringify(errs));
  await b.close();
})();
