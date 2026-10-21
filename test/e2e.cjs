// Drives the real page in headless Chromium. Run: node test/e2e.cjs http://localhost:8731/
const { chromium } = require(process.env.PW || "playwright");
const fs = require("fs"), path = require("path");
const url = process.argv[2] || "http://localhost:8731/";
const fx = path.join(__dirname, "fixtures"), out = path.join(__dirname, "out");
(async () => {
  const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const p = await b.newPage({ viewport: { width: 900, height: 1100 } });
  const requests = [];
  p.on("request", (r) => { if (!r.url().startsWith("http://localhost")) requests.push(r.url()); });
  p.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.log("console", m.type(), m.text()); });
  p.on("pageerror", (e) => console.log("pageerror:", e.message));
  await p.goto(url);
  const names = process.argv.slice(3).length ? process.argv.slice(3) : ["sample.txt","sample.md","sample.csv","sample.xlsx","sample.docx","sample.pdf","scan-like.pdf"];
  await p.setInputFiles("#picker", names.map((n) => path.join(fx, n)));
  await p.waitForFunction((n) => [...document.querySelectorAll(".file .state")].filter((s) => /^(Done|Could not|Not supported)/.test(s.textContent)).length === n, names.length, { timeout: 1800000 });
  await p.screenshot({ path: path.join(out, "page.png"), fullPage: true });
  const cards = await p.$$eval(".file", (els) => els.map((e) => ({
    name: e.querySelector(".fname").textContent, state: e.querySelector(".state").textContent,
    found: e.querySelector(".found").textContent, notes: [...e.querySelectorAll(".notes li")].map((l) => l.textContent),
    href: e.querySelector("a.btn")?.href, dl: e.querySelector("a.btn")?.download })));
  for (const c of cards) {
    console.log(`\n== ${c.name}: ${c.state}\n   ${c.found}\n   notes: ${JSON.stringify(c.notes)}`);
    if (c.href) {
      const b64 = await p.evaluate(async (h) => { const buf = new Uint8Array(await (await fetch(h)).arrayBuffer()); let s = ""; for (const x of buf) s += String.fromCharCode(x); return btoa(s); }, c.href);
      fs.writeFileSync(path.join(out, c.dl), Buffer.from(b64, "base64"));
    }
  }
  console.log("\nexternal requests:", JSON.stringify(requests));
  await b.close();
})();
