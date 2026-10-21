// Drives the real page in headless Chromium. Run: node test/e2e.cjs http://localhost:8731/
// Locked files (locked.*) exercise the password workflow: the "Needs a
// password" card, a wrong-password retry, unlocking via Enter and via click,
// and (with ONLYUNLOCK=1) the "only remove the password" checkbox.
const { chromium } = require(process.env.PW || "playwright");
const fs = require("fs"), path = require("path"), assert = require("assert");
const url = process.argv[2] || "http://localhost:8731/";
const fx = path.join(__dirname, "fixtures"), out = path.join(__dirname, "out");
const LOCKPW = process.env.LOCKPW || "correct-horse";
const ONLYUNLOCK = process.env.ONLYUNLOCK === "1";
// Locked files go first: if a locked file ever blocked the queue, the plain
// files behind it could never finish and the settle wait below would time out.
const names = process.argv.slice(3).length ? process.argv.slice(3) : ["sample.txt","sample.md","sample.csv","sample.xlsx","sample.docx","sample.pdf","scan-like.pdf"];
names.sort((a, b) => (a.startsWith("locked.") ? -1 : 0) - (b.startsWith("locked.") ? -1 : 0));
const lockedNames = names.filter((n) => path.basename(n).startsWith("locked."));
const PII = {
  "locked.pdf": ["ABCDE1234F", "priya.nair@example.com", "98765 43210"],
  "locked.docx": ["ABCDE1234F", "priya.nair7@example.com", "98765 43210"],
  "locked.xlsx": ["ABCDE1234F", "person7@example.com"],
};
const terminal = (s) => /^(Done|Could not|Not supported)/.test(s);
(async () => {
  const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const p = await b.newPage({ viewport: { width: 900, height: 1100 } });
  const requests = [];
  p.on("request", (r) => { if (!r.url().startsWith("http://localhost")) requests.push(r.url()); });
  p.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.log("console", m.type(), m.text()); });
  p.on("pageerror", (e) => console.log("pageerror:", e.message));
  await p.goto(url);
  if (process.env.MANUAL) await p.fill("#optManual", process.env.MANUAL);
  if (process.env.NOAI) await p.uncheck("#optAi");
  if (ONLYUNLOCK) await p.check("#optOnlyUnlock");
  await p.setInputFiles("#picker", names.map((n) => path.join(fx, n)));
  const cardState = (name) => p.evaluate((nm) => {
    const el = [...document.querySelectorAll(".file")].find((e) => e.querySelector(".fname").textContent === nm);
    if (!el) return "missing";
    return {
      state: el.querySelector(".state").textContent,
      lockVisible: !el.querySelector(".pw").hidden,
      inputType: el.querySelector(".pw input").type,
      autocomplete: el.querySelector(".pw input").getAttribute("autocomplete"),
      err: el.querySelector(".pwerr").hidden ? "" : el.querySelector(".pwerr").textContent,
      found: el.querySelector(".found").textContent,
      notes: [...el.querySelectorAll(".notes li")].map((l) => l.textContent),
    };
  }, name);
  if (lockedNames.length) {
    // Every locked file must show the password box while the plain files
    // finish on their own (a blocked queue would hang here forever).
    for (const n of lockedNames) {
      await p.waitForFunction((nm) => {
        const el = [...document.querySelectorAll(".file")].find((e) => e.querySelector(".fname").textContent === nm);
        return el && el.querySelector(".state").textContent === "Needs a password" && !el.querySelector(".pw").hidden;
      }, n, { timeout: 120000 });
      const st = await cardState(n);
      assert.strictEqual(st.inputType, "password", `${n}: password box`);
      assert.strictEqual(st.autocomplete, "off", `${n}: autocomplete off`);
      console.log(`lock UI ok for ${n}`);
    }
    for (const n of names) {
      if (lockedNames.includes(n)) continue;
      await p.waitForFunction((nm) => {
        const el = [...document.querySelectorAll(".file")].find((e) => e.querySelector(".fname").textContent === nm);
        return el && /^(Done|Could not|Not supported)/.test(el.querySelector(".state").textContent);
      }, n, { timeout: 600000 });
    }
    console.log("plain files finished while locked files waited: queue not blocked");

    // Wrong password on the first locked file: clear message, box stays.
    const first = lockedNames[0];
    const wrongByEnter = p.locator(".file", { hasText: first }).locator(".pw input");
    await wrongByEnter.fill("wrong-horse");
    await wrongByEnter.press("Enter");
    await p.waitForFunction((nm) => {
      const el = [...document.querySelectorAll(".file")].find((e) => e.querySelector(".fname").textContent === nm);
      return el && !el.querySelector(".pwerr").hidden && el.querySelector(".state").textContent === "Needs a password";
    }, first, { timeout: 120000 });
    console.log(`wrong-password retry ok for ${first}:`, (await cardState(first)).err);

    // Right password everywhere: Enter for the first file, the Unlock
    // button for the rest (both must resume processing).
    for (const [i, n] of lockedNames.entries()) {
      const scope = p.locator(".file", { hasText: n });
      await scope.locator(".pw input").fill(LOCKPW);
      if (i === 0) await scope.locator(".pw input").press("Enter");
      else await scope.locator('.pw button[type="submit"]').click();
    }
    for (const n of lockedNames) {
      await p.waitForFunction((nm) => {
        const el = [...document.querySelectorAll(".file")].find((e) => e.querySelector(".fname").textContent === nm);
        return el && /^(Done|Could not)/.test(el.querySelector(".state").textContent);
      }, n, { timeout: 600000 });
      const st = await cardState(n);
      assert.ok(/^Done/.test(st.state), `${n} unlocked to Done (got: ${st.state})`);
      console.log(`${n}: Done. found=[${st.found}] notes=${JSON.stringify(st.notes)}`);
      if (ONLYUNLOCK) {
        assert.match(st.found, /Password removed/, `${n}: only-unlock summary`);
        assert.ok(st.notes.some((t) => /Password removed/.test(t)), `${n}: only-unlock warning`);
      } else {
        assert.ok(!/Password removed/.test(st.found), `${n}: redacted, not just unlocked`);
      }
    }
    // The downloads must open with NO password. Office files must also be
    // valid zips; redacted ones must not contain PII, only-unlocked ones must.
    const checks = await p.evaluate(async ({ locked, onlyUnlock }) => {
      const out = [];
      const cards = [...document.querySelectorAll(".file")];
      for (const nm of locked) {
        const el = cards.find((e) => e.querySelector(".fname").textContent === nm);
        const href = el.querySelector("a.btn").href;
        const buf = new Uint8Array(await (await fetch(href)).arrayBuffer());
        const raw = new TextDecoder("latin1").decode(buf.subarray(0, Math.min(buf.length, 3000000)));
        const res = { name: nm, encryptedMarker: raw.includes("/Encrypt"), zipMagic: buf[0] === 0x50 && buf[1] === 0x4b, text: "" };
        if (nm.endsWith(".pdf")) {
          const lib = await import("/vendor/pdfjs/pdf.min.mjs");
          lib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.mjs";
          const doc = await lib.getDocument({ data: buf, isEvalSupported: false }).promise; // throws if still locked
          let t = "";
          for (let i = 1; i <= doc.numPages; i++) {
            const c = await doc.getPage(i).then((pg) => pg.getTextContent());
            t += c.items.map((it) => it.str).join(" ");
          }
          await doc.destroy();
          res.text = t;
          res.pages = doc.numPages;
        } else {
          const zip = await JSZip.loadAsync(buf); // throws if still encrypted
          const blobs = [];
          for (const k of Object.keys(zip.files)) {
            if (/\.(xml|rels)$/.test(k)) blobs.push(await zip.file(k).async("string"));
          }
          res.text = blobs.join("\n");
        }
        out.push(res);
      }
      return out;
    }, { locked: lockedNames, onlyUnlock: ONLYUNLOCK });
    for (const c of checks) {
      assert.strictEqual(c.encryptedMarker, false, `${c.name}: no /Encrypt marker`);
      if (!c.name.endsWith(".pdf")) assert.strictEqual(c.zipMagic, true, `${c.name}: plain zip`);
      // A re-rendered PDF is images only, so its text cannot carry PII in
      // either mode; page count preservation is the fidelity check there.
      if (c.name.endsWith(".pdf") && ONLYUNLOCK) {
        assert.strictEqual(c.pages, 1, `${c.name}: only-unlock keeps all pages`);
      } else {
        for (const s of PII[path.basename(c.name)] || []) {
          if (ONLYUNLOCK) assert.ok(c.text.includes(s), `${c.name}: only-unlock keeps ${s}`);
          else assert.ok(!c.text.includes(s), `${c.name}: redacted, no ${s}`);
        }
      }
      console.log(`download verified for ${c.name} (onlyUnlock=${ONLYUNLOCK})`);
    }
  } else {
    await p.waitForFunction((n) => [...document.querySelectorAll(".file .state")].filter((s) => /^(Done|Could not|Not supported)/.test(s.textContent)).length === n, names.length, { timeout: 1800000 });
  }

  // ------------------------------------------------- redaction report checks
  // Every finished card must show a collapsed "What was hidden" section, a
  // per-file report CSV, and (when files are done) a combined-reports button.
  // The CSV must list exact original quotes with locations, and the ZIP must
  // NOT contain reports.
  const parseReportCsv = (text) => {
    const raw = String(text).replace(/^\uFEFF/, "");
    const rows = [];
    let row = [], field = "", quoted = false;
    const pushField = () => { row.push(field); field = ""; };
    // Skip privacy comment lines starting with # (single-line, no quotes).
    const lines = [];
    for (const ln of raw.split(/\r?\n/)) {
      if (!ln) continue;
      if (ln.startsWith("#")) continue;
      lines.push(ln);
    }
    const body = lines.join("\n");
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (quoted) {
        if (ch === '"') {
          if (body[i + 1] === '"') { field += '"'; i++; }
          else quoted = false;
        } else field += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ",") pushField();
      else if (ch === "\n") { pushField(); rows.push(row); row = []; }
      else field += ch;
    }
    if (field !== "" || row.length) { pushField(); rows.push(row); }
    if (!rows.length) return { header: [], rows: [] };
    const header = rows[0];
    return { header, rows: rows.slice(1).filter((r) => r.length > 1 || (r.length === 1 && r[0] !== "")) };
  };
  const reportInfo = await p.$$eval(".file", (els) => els.map((e) => ({
    name: e.querySelector(".fname").textContent,
    state: e.querySelector(".state").textContent,
    summary: e.querySelector(".rep summary")?.textContent || "",
    repHidden: e.querySelector(".rep")?.hidden ?? true,
    tableRows: e.querySelectorAll(".rep tbody tr").length,
    repHref: e.querySelector("a.repdl")?.href || "",
    repDl: e.querySelector("a.repdl")?.download || "",
    warn: e.querySelector(".repwarn")?.textContent || "",
  })));
  const AI_ON = !process.env.NOAI;
  const MANUAL_LIST = String(process.env.MANUAL || "").split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
  // Original PDF texts (via the page's own pdf.js) for quote verification.
  const pdfNames = [...new Set(names.filter((n) => n.toLowerCase().endsWith(".pdf")).flatMap((n) => (
    path.basename(n) === "locked.pdf" ? [n, "sample.pdf"] : [n]
  )))];
  const pdfTexts = await p.evaluate(async (pdfs) => {
    const out = {};
    const lib = await import("/vendor/pdfjs/pdf.min.mjs");
    lib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.mjs";
    for (const nm of pdfs) {
      try {
        const res = await fetch(`/test/fixtures/${nm}`);
        const data = new Uint8Array(await res.arrayBuffer());
        const doc = await lib.getDocument({ data, isEvalSupported: false }).promise;
        let t = "";
        for (let i = 1; i <= doc.numPages; i++) {
          const c = await doc.getPage(i).then((pg) => pg.getTextContent());
          t += `\n[PAGE ${i}]\n` + c.items.map((it) => it.str).join(" ");
        }
        await doc.destroy();
        out[nm] = t;
      } catch (e) { out[nm] = `ERROR ${e.message}`; }
    }
    return out;
  }, pdfNames);
  const normWs = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const unguard = (q) => (/^'[=+\-@\t\r]/.test(q) ? q.slice(1) : q);
  const XLSX_LIB = require("/home/user/pii-redactor/tools/node_modules/xlsx");
  const JSZIP_LIB = require("/home/user/pii-redactor/tools/node_modules/jszip");
  const cellTextsOf = (filePath) => {
    const wb = XLSX_LIB.readFile(filePath, { cellDates: true });
    const vals = [];
    for (const sn of wb.SheetNames) {
      const sh = wb.Sheets[sn];
      for (const k of Object.keys(sh)) {
        if (k.startsWith("!")) continue;
        const cell = sh[k];
        if (cell?.w != null) vals.push(String(cell.w));
        if (cell?.v != null) vals.push(String(cell.v instanceof Date ? cell.v.toISOString() : cell.v));
      }
    }
    return vals;
  };
  const docxTextsOf = async (filePath) => {
    const buf = fs.readFileSync(filePath);
    const zip = await JSZIP_LIB.loadAsync(buf);
    const parts = [];
    for (const k of Object.keys(zip.files)) {
      if (/\.(xml|rels)$/.test(k)) parts.push(await zip.file(k).async("string"));
    }
    const raw = parts.join("\n");
    // Pull <w:t> text (runs may split a quote across nodes) plus rel targets.
    const texts = [];
    for (const m of raw.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)) texts.push(m[1]);
    for (const m of raw.matchAll(/Target="([^"]*)"/g)) texts.push(m[1]);
    texts.push(raw);
    // Run-split quotes ("ABCDE"+"1234F") only appear when runs are joined.
    texts.push(texts.join(""));
    return texts.join("\n");
  };
  const allReportRows = [];
  for (const info of reportInfo) {
    if (!/^(Done|Could not|Not supported)/.test(info.state)) continue;
    if (/^Could not|Not supported/.test(info.state)) continue;
    console.log(`report card for ${info.name}: summary=[${info.summary}] tableRows=${info.tableRows}`);
    assert.ok(/What was hidden \(\d+ items\)/.test(info.summary), `${info.name}: report summary`);
    assert.ok(info.warn.includes("never send it along with the redacted file"), `${info.name}: privacy wording on card`);
    assert.ok(info.repHref, `${info.name}: report download link`);
    assert.ok(info.repDl.endsWith(".csv"), `${info.name}: report download is csv`);
    const csvBuf = await p.evaluate(async (h) => {
      const buf = new Uint8Array(await (await fetch(h)).arrayBuffer());
      let s = "";
      for (const x of buf) s += String.fromCharCode(x);
      return btoa(s);
    }, info.repHref);
    const csvText = Buffer.from(csvBuf, "base64").toString("utf8");
    assert.ok(csvText.charCodeAt(0) === 0xfeff, `${info.name}: report CSV has BOM`);
    assert.ok(csvText.includes("WARNING: This report contains the ORIGINAL sensitive text"), `${info.name}: privacy in CSV`);
    const { header, rows } = parseReportCsv(csvText);
    assert.deepStrictEqual(header, ["file", "location", "page", "type", "quote", "found_by", "detail"], `${info.name}: csv columns`);
    fs.writeFileSync(path.join(out, info.repDl), Buffer.from(csvBuf, "base64"));
    const n = parseInt((info.summary.match(/\((\d+) items\)/) || [])[1] || "0", 10);
    assert.strictEqual(rows.length, n, `${info.name}: csv rows match summary count`);
    assert.ok(info.tableRows === Math.min(n, 200), `${info.name}: on-page table capped at 200`);
    // Location + quote checks per format.
    const base = path.basename(info.name);
    // Locked files are encrypted on disk: verify against their unlocked sources.
    const origFor = (b) => {
      if (b === "locked.pdf") return "sample.pdf";
      if (b === "locked.docx") return "locked-src.docx";
      if (b === "locked.xlsx") return "locked-src.xlsx";
      return b;
    };
    const quotesInOriginal = async (quote) => {
      if (!quote) return false;
      const q = unguard(quote);
      const orig = origFor(base);
      if (/\.(txt|md|csv)$/i.test(orig)) {
        return fs.readFileSync(path.join(fx, orig), "utf8").includes(q);
      }
      if (/\.(xlsx|xls)$/i.test(orig)) {
        return cellTextsOf(path.join(fx, orig)).some((c) => c.includes(q));
      }
      if (/\.docx$/i.test(orig)) {
        return (await docxTextsOf(path.join(fx, orig))).includes(q);
      }
      if (/\.pdf$/i.test(orig)) {
        const t = pdfTexts[orig] || pdfTexts[base] || "";
        return t.includes(q) || normWs(t).toLowerCase().includes(normWs(q).toLowerCase());
      }
      return true;
    };
    for (const r of rows) {
      const [file, location, page, type, quote, foundBy, detail] = r;
      assert.strictEqual(file, info.name, `${info.name}: csv file column`);
      assert.ok(location && type && quote && foundBy, `${info.name}: row has location/type/quote/found_by`);
      assert.ok(["script", "script: name cue", "script: column header", "you", "needle"].includes(foundBy), `${info.name}: known found_by (${foundBy})`);
      assert.ok(await quotesInOriginal(quote), `${info.name}: quote occurs in original: ${JSON.stringify(quote.slice(0, 60))}`);
      allReportRows.push({ base, location, page, type, quote, foundBy, detail });
    }
    // Per-fixture location expectations.
    const locs = rows.map((r) => r[1]);
    const pages = rows.map((r) => r[2]);
    if (base === "multi.pdf" && !ONLYUNLOCK) {
      const mail = rows.find((r) => unguard(r[4]).includes("@"));
      const pan = rows.find((r) => unguard(r[4]).includes("ABCDE1234F"));
      assert.ok(mail, "multi.pdf: email row");
      assert.ok(pan, "multi.pdf: PAN row");
      assert.strictEqual(mail[2], "1", "multi.pdf: email on page 1");
      assert.strictEqual(pan[2], "2", "multi.pdf: PAN on page 2");
    }
    if ((base === "sample.pdf" || base === "mixed.pdf" || base === "rotated.pdf") && rows.length && !ONLYUNLOCK) {
      assert.ok(pages.every((pg) => /^[1-9]\d*$/.test(pg)), `${base}: every row has a page number`);
      assert.ok(locs.every((l) => /^page \d+, line \d+$/.test(l)), `${base}: pdf locations carry page+line`);
    }
    if (base === "finance.txt" && rows.length) {
      assert.ok(locs.every((l) => /^line \d+$/.test(l)), "finance.txt: line locations");
      for (const r of rows) {
        const ln = parseInt(r[1].match(/line (\d+)/)[1], 10);
        const origLines = fs.readFileSync(path.join(fx, base), "utf8").split("\n");
        assert.ok((origLines[ln - 1] || "").includes(unguard(r[4])), `finance.txt: quote on line ${ln}`);
      }
    }
    if ((base === "sample.csv" || base === "edge.csv") && rows.length) {
      assert.ok(locs.every((l) => /^row \d+, column /.test(l)), `${base}: csv row/column locations`);
    }
    if (base === "titlerow.xlsx" && rows.length && !ONLYUNLOCK) {
      assert.ok(rows.some((r) => r[5] === "script: column header"), "titlerow.xlsx: header-column hiding reported");
      assert.ok(locs.every((l) => /^.+![A-Z]+\d+$/.test(l)), "titlerow.xlsx: Sheet!Cell locations");
    }
    if ((base === "sample.xlsx" || base === "edge.xlsx" || base === "legacy.xls") && rows.length && !ONLYUNLOCK) {
      assert.ok(locs.every((l) => /^.+![A-Z]+\d+$/.test(l)), `${base}: Sheet!Cell locations`);
    }
    if (base === "edge.docx" && rows.length && !ONLYUNLOCK) {
      assert.ok(locs.some((l) => /table \d+, row \d+, cell \d+/.test(l)), "edge.docx: table locations");
      assert.ok(locs.every((l) => /paragraph|table \d+|hyperlink|field|header|footer|comment|footnote/.test(l)), "edge.docx: docx-style locations");
      if (MANUAL_LIST.length) {
        assert.ok(locs.some((l) => /paragraph/.test(l)), "edge.docx with manual list: paragraph locations");
      }
    }
    if (base === "sample.docx" && rows.length && !ONLYUNLOCK) {
      assert.ok(locs.some((l) => /paragraph/.test(l)), "sample.docx: paragraph locations");
    }
    if (ONLYUNLOCK && info.name.startsWith("locked.")) {
      assert.strictEqual(rows.length, 0, `${info.name}: only-unlock report is empty`);
    }
  }
  // Manual-list entries surface as found_by "you".
  if (MANUAL_LIST.length && !ONLYUNLOCK) {
    const youRows = allReportRows.filter((r) => r.foundBy === "you");
    assert.ok(youRows.length > 0, "manual list produced 'you' rows");
    for (const r of youRows) {
      assert.ok(MANUAL_LIST.some((m) => m.toLowerCase() === String(r.detail).toLowerCase()), `manual detail matches entry (${r.detail})`);
    }
    console.log(`manual-list rows ok: ${youRows.length}`);
  }
  // Needle entries for the finance sample (AI on only).
  if (AI_ON && !ONLYUNLOCK && names.includes("finance.txt")) {
    const fin = allReportRows.filter((r) => r.base === "finance.txt");
    const lic = fin.find((r) => unguard(r.quote).includes("LIC/0034/998877"));
    const sec = fin.find((r) => /sunshine99/i.test(unguard(r.quote)));
    assert.ok(lic, "finance.txt: LIC/0034/998877 row present");
    assert.strictEqual(lic.foundBy, "needle", "finance.txt: LIC found by needle");
    assert.ok(sec, "finance.txt: sunshine99 row present");
    assert.strictEqual(sec.foundBy, "needle", "finance.txt: password found by needle");
    console.log("needle rows ok for finance.txt");
  }
  // Combined reports button: one CSV covering every file; ZIP must exclude reports.
  if (!ONLYUNLOCK) {
    const dlVisible = await p.evaluate(() => !document.getElementById("dlReports").hidden);
    assert.ok(dlVisible, "Download all reports button visible");
    const [dl] = await Promise.all([p.waitForEvent("download", { timeout: 30000 }), p.click("#dlReports")]);
    const dlPath = await dl.path();
    const combined = fs.readFileSync(dlPath, "utf8");
    const { header, rows } = parseReportCsv(combined);
    assert.deepStrictEqual(header, ["file", "location", "page", "type", "quote", "found_by", "detail"]);
    assert.ok(rows.length >= allReportRows.length, "combined csv holds all rows");
    console.log(`combined reports csv ok: ${rows.length} rows`);
  }
  if (reportInfo.filter((i) => /^(Done)/.test(i.state)).length >= 2 && !ONLYUNLOCK) {
    const [dl] = await Promise.all([p.waitForEvent("download", { timeout: 30000 }), p.click("#zipAll")]);
    const zipPath = await dl.path();
    const zip = await JSZIP_LIB.loadAsync(fs.readFileSync(zipPath));
    const znames = Object.keys(zip.files);
    assert.ok(!znames.some((z) => /report\.csv$/i.test(z)), "ZIP excludes report CSVs");
    console.log(`zip excludes reports ok: ${JSON.stringify(znames)}`);
  }
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
})().catch((e) => { console.error("E2E FAILED:", e); process.exit(1); });
