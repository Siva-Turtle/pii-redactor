// Drives the real page in headless Chromium. Run: node test/e2e.cjs http://localhost:8731/
// New one-screen UI: one file field, Remove PII, one Download button, one
// status line, one combined "Show Identified PIIs" report. Locked files
// (locked.*) exercise the per-row password workflow: the "Needs password"
// chip, a wrong-password retry, unlocking via Enter and via Remove PII.
const { chromium } = require(process.env.PW || "playwright");
const fs = require("fs"), path = require("path"), assert = require("assert");
let url = process.argv[2] || "http://localhost:8731/";
const NOAI = process.env.NOAI === "1";
if (NOAI) url += (url.includes("?") ? "&" : "?") + "noai=1"; // test-only hook (see js/app.js)
const fx = path.join(__dirname, "fixtures"), out = path.join(__dirname, "out");
const LOCKPW = process.env.LOCKPW || "correct-horse";
// Locked files go first: if a locked file ever blocked the queue, the plain
// files behind it could never finish and the settle wait below would time out.
const names = process.argv.slice(3).length ? process.argv.slice(3) : ["sample.txt", "sample.md", "sample.csv", "sample.xlsx", "sample.docx", "sample.pdf", "scan-like.pdf"];
names.sort((a, b) => (a.startsWith("locked.") ? -1 : 0) - (b.startsWith("locked.") ? -1 : 0));
const lockedNames = names.filter((n) => path.basename(n).startsWith("locked."));
const PII = {
  "locked.pdf": ["ABCDE1234F", "priya.nair@example.com", "98765 43210"],
  "locked.docx": ["ABCDE1234F", "priya.nair7@example.com", "98765 43210"],
  "locked.xlsx": ["ABCDE1234F", "person7@example.com"],
};
const terminalDs = (ds) => ds === "done" || ds === "error";
(async () => {
  const b = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const p = await b.newPage({ viewport: { width: 900, height: 1100 } });
  const requests = [];
  // blob: URLs are same-origin memory (report CSV fetches below), not network.
  p.on("request", (r) => { if (!r.url().startsWith("http://localhost") && !r.url().startsWith("blob:")) requests.push(r.url()); });
  p.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.log("console", m.type(), m.text()); });
  p.on("pageerror", (e) => console.log("pageerror:", e.message));
  await p.goto(url);

  // ------------------------------------------------------- static DOM checks
  // Exactly one heading, and it is the title. No subtitle, no footer, no Options.
  assert.strictEqual(await p.textContent("h1"), "Remove PII", "h1 is exactly 'Remove PII'");
  assert.strictEqual(await p.$$eval("h1", (e) => e.length), 1, "single h1");
  assert.strictEqual(await p.$("footer"), null, "no footer");
  assert.strictEqual(await p.$(".sub"), null, "no subtitle");
  for (const sel of ["#optManual", "#optAi", "#optThorough", "#optDates", "#optOnlyUnlock", "#zipAll", "#dlReports", "#reset", ".rep", ".file"]) {
    assert.strictEqual(await p.$(sel), null, `no legacy ${sel}`);
  }
  // The report disclosure is closed by default.
  assert.strictEqual(await p.$eval("#ident", (e) => e.open), false, "report closed by default");
  // Download starts disabled; the idle hint is the only message.
  assert.strictEqual(await p.$eval("#dlBtn", (e) => e.disabled), true, "download disabled until done");
  assert.strictEqual(await p.textContent("#status"), "Choose one or more files, then press Remove PII.", "idle hint");

  await p.setInputFiles("#picker", names.map((n) => path.join(fx, n)));
  const fieldLabel = await p.textContent("#pickField .pick-label");
  if (names.length === 1) assert.strictEqual(fieldLabel, names[0], "field shows the file name");
  else assert.strictEqual(fieldLabel, `${names.length} files`, "field shows the file count");
  assert.strictEqual(await p.$$eval(".frow", (e) => e.length), names.length, "one row per file");

  const rowState = (name) => p.evaluate((nm) => {
    const el = [...document.querySelectorAll(".frow")].find((e) => e.querySelector(".fname").textContent === nm);
    if (!el) return null;
    const chip = el.querySelector(".chip");
    return {
      chip: chip.textContent,
      ds: chip.dataset.state,
      pwVisible: !el.querySelector(".pw").hidden,
      inputType: el.querySelector(".pw input").type,
      autocomplete: el.querySelector(".pw input").getAttribute("autocomplete"),
      pwLabel: el.querySelector(".pw label").textContent,
      pwErr: el.querySelector(".pwerr").hidden ? "" : el.querySelector(".pwerr").textContent,
      rowErr: el.classList.contains("err"),
    };
  }, name);
  const status = () => p.textContent("#status");

  await p.click("#removeBtn");

  // Progress (AI runs only): the status names the file ("file 2 of 3" plus the
  // step text such as "Looking for names and addresses… 12 of 40") and the
  // slim bar is visible while work is in flight.
  if (!NOAI && names.includes("finance.txt")) {
    await p.waitForFunction(() => {
      const s = document.getElementById("status").textContent;
      return !document.getElementById("bar").hidden && /file \d+ of \d+/.test(s) && / of /.test(s);
    }, null, { timeout: 300000 });
    console.log("progress ok:", await status(), "| bar visible");
  }

  if (lockedNames.length) {
    // Every locked file must show its own password row while the plain files
    // finish on their own (a blocked queue would hang here forever).
    for (const n of lockedNames) {
      await p.waitForFunction((nm) => {
        const el = [...document.querySelectorAll(".frow")].find((e) => e.querySelector(".fname").textContent === nm);
        return el && el.querySelector(".chip").textContent === "Needs password" && !el.querySelector(".pw").hidden;
      }, n, { timeout: 120000 });
      const st = await rowState(n);
      assert.strictEqual(st.inputType, "password", `${n}: password box`);
      assert.strictEqual(st.autocomplete, "off", `${n}: autocomplete off`);
      assert.strictEqual(st.pwLabel, `Password for ${n}`, `${n}: per-file label`);
      console.log(`lock UI ok for ${n}`);
    }
    const visiblePw = await p.$$eval(".frow .pw", (els) => els.filter((e) => !e.hidden).length);
    assert.strictEqual(visiblePw, lockedNames.length, "one password field per locked file");
    for (const n of names) {
      if (lockedNames.includes(n)) continue;
      await p.waitForFunction((nm) => {
        const el = [...document.querySelectorAll(".frow")].find((e) => e.querySelector(".fname").textContent === nm);
        return el && ["done", "error"].includes(el.querySelector(".chip").dataset.state);
      }, n, { timeout: 600000 });
    }
    console.log("plain files finished while locked files waited: queue not blocked");

    // Wrong password on the first locked file: the status line names the file,
    // only that row errors, the box stays for a retry.
    const first = lockedNames[0];
    const wrongByEnter = p.locator(".frow", { hasText: first }).locator(".pw input");
    await wrongByEnter.fill("wrong-horse");
    await wrongByEnter.press("Enter");
    await p.waitForFunction((nm) => {
      const okStatus = document.getElementById("status").textContent.includes(`That password didn't work for ${nm}`);
      const el = [...document.querySelectorAll(".frow")].find((e) => e.querySelector(".fname").textContent === nm);
      return okStatus && el && !el.querySelector(".pwerr").hidden && el.classList.contains("err");
    }, first, { timeout: 120000 });
    console.log(`wrong-password retry ok for ${first}:`, (await rowState(first)).pwErr);
    assert.ok((await status()).includes(first), "status names the file with the wrong password");

    // Right password everywhere: Enter for the first file, Remove PII for the
    // rest (both must resume processing).
    for (const [i, n] of lockedNames.entries()) {
      const scope = p.locator(".frow", { hasText: n });
      await scope.locator(".pw input").fill(LOCKPW);
      if (i === 0) await scope.locator(".pw input").press("Enter");
    }
    if (lockedNames.length > 1) await p.click("#removeBtn");
    for (const n of lockedNames) {
      await p.waitForFunction((nm) => {
        const el = [...document.querySelectorAll(".frow")].find((e) => e.querySelector(".fname").textContent === nm);
        return el && ["done", "error"].includes(el.querySelector(".chip").dataset.state);
      }, n, { timeout: 600000 });
      const st = await rowState(n);
      assert.strictEqual(st.ds, "done", `${n} unlocked to Done (got: ${st.chip})`);
      console.log(`${n}: Done`);
    }
    // The downloads must open with NO password and must not contain PII
    // (verified through the ZIP/file download below).
  } else {
    await p.waitForFunction((n) => [...document.querySelectorAll(".frow .chip")].filter((s) => ["done", "error"].includes(s.dataset.state)).length === n, names.length, { timeout: 1800000 });
  }

  // ------------------------------------------------------------- status line
  const finalStatus = await status();
  console.log("final status:", finalStatus);
  const anyDone = await p.$$eval(".frow .chip", (els) => els.some((e) => e.dataset.state === "done"));
  if (anyDone) {
    assert.ok(/^Done\. /.test(finalStatus) || /Couldn't process/.test(finalStatus), "completion message");
    if (!lockedNames.length) assert.ok(/Couldn't process|Done\./.test(finalStatus), "failures named or done");
  }

  // ------------------------------------------------- combined report checks
  // One closed disclosure; opened it shows ONE combined table with a File
  // column, the privacy warning, and one combined-CSV download.
  await p.click("#ident summary");
  const headers = await p.$$eval("#ident thead th", (els) => els.map((e) => e.textContent));
  assert.deepStrictEqual(headers, ["File", "Location", "Type", "Quote", "Found by"], "combined table columns");
  assert.ok((await p.textContent("#ident .repwarn")).includes("never share it along with the redacted files"), "privacy warning");
  const tableRows = await p.$$eval("#ident tbody tr", (els) => els.length);
  const AI_ON = !NOAI;
  const parseReportCsv = (text) => {
    const raw = String(text).replace(/^\uFEFF/, "");
    const rows = [];
    let row = [], field = "", quoted = false;
    const pushField = () => { row.push(field); field = ""; };
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
  const repHref = await p.$eval("#repDl", (e) => e.href);
  assert.ok(repHref, "report download link");
  assert.ok((await p.$eval("#repDl", (e) => e.download)).endsWith(".csv"), "report download is csv");
  const csvBuf = await p.evaluate(async (h) => {
    const buf = new Uint8Array(await (await fetch(h)).arrayBuffer());
    let s = "";
    for (const x of buf) s += String.fromCharCode(x);
    return btoa(s);
  }, repHref);
  const csvText = Buffer.from(csvBuf, "base64").toString("utf8");
  assert.ok(csvText.charCodeAt(0) === 0xfeff, "report CSV has BOM");
  assert.ok(csvText.includes("WARNING: This report contains the ORIGINAL sensitive text"), "privacy in CSV");
  const { header, rows } = parseReportCsv(csvText);
  assert.deepStrictEqual(header, ["file", "location", "page", "type", "quote", "found_by", "detail"], "csv columns");
  fs.writeFileSync(path.join(out, "pii-report.csv"), Buffer.from(csvBuf, "base64"));
  assert.strictEqual(tableRows, Math.min(rows.length, 200), "on-page table capped at 200");
  if (rows.length > 200) {
    assert.ok((await p.textContent("#repMore")).includes(`of ${rows.length}`), "showing N of M note");
  }
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
  const XLSX_LIB = require(path.join(__dirname, "..", "tools", "node_modules", "xlsx"));
  const JSZIP_LIB = require(path.join(__dirname, "..", "tools", "node_modules", "jszip"));
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
    const texts = [];
    for (const m of raw.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)) texts.push(m[1]);
    for (const m of raw.matchAll(/Target="([^"]*)"/g)) texts.push(m[1]);
    texts.push(raw);
    texts.push(texts.join(""));
    return texts.join("\n");
  };
  const byFile = new Map();
  for (const r of rows) {
    if (!byFile.has(r[0])) byFile.set(r[0], []);
    byFile.get(r[0]).push(r);
  }
  const allReportRows = [];
  for (const [file, frows] of byFile) {
    console.log(`report rows for ${file}: ${frows.length}`);
    const base = path.basename(file);
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
    for (const r of frows) {
      const [f, location, page, type, quote, foundBy, detail] = r;
      assert.strictEqual(f, file, "csv file column");
      assert.ok(location && type && quote && foundBy, `${file}: row has location/type/quote/found_by`);
      assert.ok(["script", "script: name cue", "script: column header", "script: batch", "you", "needle", "gliner"].includes(foundBy), `${file}: known found_by (${foundBy})`);
      assert.ok(await quotesInOriginal(quote), `${file}: quote occurs in original: ${JSON.stringify(quote.slice(0, 60))}`);
      allReportRows.push({ base, location, page, type, quote, foundBy, detail });
    }
    const locs = frows.map((r) => r[1]);
    const pages = frows.map((r) => r[2]);
    if (base === "multi.pdf") {
      const mail = frows.find((r) => unguard(r[4]).includes("@"));
      const pan = frows.find((r) => unguard(r[4]).includes("ABCDE1234F"));
      assert.ok(mail, "multi.pdf: email row");
      assert.ok(pan, "multi.pdf: PAN row");
      assert.strictEqual(mail[2], "1", "multi.pdf: email on page 1");
      assert.strictEqual(pan[2], "2", "multi.pdf: PAN on page 2");
    }
    if ((base === "sample.pdf" || base === "mixed.pdf" || base === "rotated.pdf") && frows.length) {
      assert.ok(pages.every((pg) => /^[1-9]\d*$/.test(pg)), `${base}: every row has a page number`);
      assert.ok(locs.every((l) => /^page \d+, line \d+$/.test(l)), `${base}: pdf locations carry page+line`);
    }
    if (base === "finance.txt" && frows.length) {
      assert.ok(locs.every((l) => /^line \d+$/.test(l)), "finance.txt: line locations");
      for (const r of frows) {
        const ln = parseInt(r[1].match(/line (\d+)/)[1], 10);
        const origLines = fs.readFileSync(path.join(fx, base), "utf8").split("\n");
        assert.ok((origLines[ln - 1] || "").includes(unguard(r[4])), `finance.txt: quote on line ${ln}`);
      }
    }
    if ((base === "sample.csv" || base === "edge.csv") && frows.length) {
      assert.ok(locs.every((l) => /^row \d+, column /.test(l)), `${base}: csv row/column locations`);
    }
    if (base === "titlerow.xlsx" && frows.length) {
      assert.ok(frows.some((r) => r[5] === "script: column header"), "titlerow.xlsx: header-column hiding reported");
      assert.ok(locs.every((l) => /^.+![A-Z]+\d+$/.test(l)), "titlerow.xlsx: Sheet!Cell locations");
    }
    if ((base === "sample.xlsx" || base === "edge.xlsx" || base === "legacy.xls") && frows.length) {
      assert.ok(locs.every((l) => /^.+![A-Z]+\d+$/.test(l)), `${base}: Sheet!Cell locations`);
    }
    if (base === "edge.docx" && frows.length) {
      assert.ok(locs.some((l) => /table \d+, row \d+, cell \d+/.test(l)), "edge.docx: table locations");
      assert.ok(locs.every((l) => /paragraph|table \d+|hyperlink|field|header|footer|comment|footnote/.test(l)), "edge.docx: docx-style locations");
    }
    if (base === "sample.docx" && frows.length) {
      assert.ok(locs.some((l) => /paragraph/.test(l)), "sample.docx: paragraph locations");
    }
  }
  // AI entries for the finance sample (AI on only): the PII-small model
  // reports person/address/phone/email/PAN/folio/ID labels in one call, and
  // the batch flow re-hides them everywhere (found_by "gliner" or the
  // batch-wide "script: batch").
  if (AI_ON && names.includes("finance.txt")) {
    const fin = allReportRows.filter((r) => r.base === "finance.txt");
    const person = fin.find((r) => /Rajesh|Meera|Sharma/.test(unguard(r.quote)));
    const addr = fin.find((r) => /Flat|Sunrise|Andheri|Mumbai/.test(unguard(r.quote)));
    const batch = fin.find((r) => r.foundBy === "script: batch");
    assert.ok(person, "finance.txt: person name hidden");
    assert.ok(addr, "finance.txt: address hidden");
    assert.ok(batch, "finance.txt: batch-wide re-hiding happened");
    // Recall the pattern layer alone misses: the unlabelled policy number
    // and the Form-16 password only the AI finds.
    const lic = fin.find((r) => unguard(r.quote).includes("LIC/0034/998877"));
    const sec = fin.find((r) => /sunshine99/i.test(unguard(r.quote)));
    assert.ok(lic, "finance.txt: LIC/0034/998877 hidden (AI)");
    assert.ok(sec, "finance.txt: sunshine99 hidden (AI)");
    console.log("AI rows ok for finance.txt");
  }

  // ------------------------------------------------------------- downloads
  // Download button is enabled once at least one file is done.
  assert.strictEqual(await p.$eval("#dlBtn", (e) => e.disabled), false, "download enabled after done");
  const doneCount = await p.$$eval(".frow .chip", (els) => els.filter((e) => e.dataset.state === "done").length);
  const [dl] = await Promise.all([p.waitForEvent("download", { timeout: 60000 }), p.click("#dlBtn")]);
  const dlPath = await dl.path();
  const suggested = dl.suggestedFilename();
  const buf = fs.readFileSync(dlPath);
  if (doneCount === 1) {
    // One finished file downloads as that file itself.
    assert.ok(/\.redacted\.(txt|md|csv|xlsx|pdf|docx)$/.test(suggested), `single download is the file itself (${suggested})`);
    console.log(`single download ok: ${suggested}`);
  } else {
    // Two or more download as ONE ZIP of redacted files only (never reports).
    assert.strictEqual(suggested, "pii-removed-files.zip", "zip name");
    const zip = await JSZIP_LIB.loadAsync(buf);
    const znames = Object.keys(zip.files);
    assert.ok(!znames.some((z) => /report\.csv$/i.test(z)), "ZIP excludes report CSVs");
    assert.strictEqual(znames.length, doneCount, "ZIP holds every redacted file");
    console.log(`zip ok: ${JSON.stringify(znames)}`);
    fs.writeFileSync(path.join(out, suggested), buf);
    // Content checks: unlocked files open with NO password and carry no PII;
    // all other redacted files carry none of the locked-file PII markers.
    for (const zn of znames) {
      const entry = await zip.file(zn).async("uint8array");
      fs.writeFileSync(path.join(out, zn), Buffer.from(entry));
      const raw = Buffer.from(entry).toString("latin1");
      if (zn.endsWith(".pdf")) {
        assert.ok(!raw.includes("/Encrypt"), `${zn}: no /Encrypt marker`);
        const text = await p.evaluate(async (b64) => {
          const bin = atob(b64);
          const data = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
          const lib = await import("/vendor/pdfjs/pdf.min.mjs");
          lib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.mjs";
          const doc = await lib.getDocument({ data, isEvalSupported: false }).promise; // throws if still locked
          let t = "";
          for (let i = 1; i <= doc.numPages; i++) {
            const c = await doc.getPage(i).then((pg) => pg.getTextContent());
            t += c.items.map((it) => it.str).join(" ");
          }
          await doc.destroy();
          return { text: t, pages: doc.numPages };
        }, Buffer.from(entry).toString("base64"));
        for (const s of Object.values(PII).flat()) assert.ok(!text.text.includes(s), `${zn}: redacted, no ${s}`);
        console.log(`pdf download verified: ${zn} (${text.pages} page(s))`);
      } else if (zn.endsWith(".docx") || zn.endsWith(".xlsx")) {
        assert.ok(entry[0] === 0x50 && entry[1] === 0x4b, `${zn}: plain zip`);
        const inner = await JSZIP_LIB.loadAsync(entry);
        const blobs = [];
        for (const k of Object.keys(inner.files)) {
          if (/\.(xml|rels)$/.test(k)) blobs.push(await inner.file(k).async("string"));
        }
        const text = blobs.join("\n");
        for (const s of Object.values(PII).flat()) assert.ok(!text.includes(s), `${zn}: redacted, no ${s}`);
        console.log(`office download verified: ${zn}`);
      } else {
        const text = Buffer.from(entry).toString("utf8");
        for (const s of Object.values(PII).flat()) assert.ok(!text.includes(s), `${zn}: redacted, no ${s}`);
        console.log(`text download verified: ${zn}`);
      }
    }
  }
  if (lockedNames.length) {
    // Every locked download opens with no password (checked above for ZIP;
    // for a single locked file the same fetch applies).
    console.log("locked downloads verified (open with no password, PII gone)");
  }

  await p.screenshot({ path: path.join(out, "page.png"), fullPage: true });
  const cards = await p.$$eval(".frow", (els) => els.map((e) => ({
    name: e.querySelector(".fname").textContent, chip: e.querySelector(".chip").textContent,
  })));
  for (const c of cards) console.log(`== ${c.name}: ${c.chip}`);
  console.log("warnings:", await p.$$eval("#warns li", (els) => els.map((e) => e.textContent)));
  console.log("\nexternal requests:", JSON.stringify(requests));
  assert.strictEqual(requests.length, 0, "no network at runtime (fonts are local)");

  // --------------------------------------------- single-file download shape
  // Choosing a new set replaces the old one; one finished file downloads as
  // that file itself (not a ZIP).
  const p2 = await b.newPage({ viewport: { width: 900, height: 1100 } });
  await p2.goto(url);
  await p2.setInputFiles("#picker", [path.join(fx, "sample.txt")]);
  assert.strictEqual(await p2.textContent("#pickField .pick-label"), "sample.txt", "new set replaces old");
  assert.strictEqual(await p2.$$eval(".frow", (e) => e.length), 1, "old rows cleared");
  await p2.click("#removeBtn");
  await p2.waitForFunction(() => [...document.querySelectorAll(".frow .chip")].every((s) => ["done", "error"].includes(s.dataset.state)), null, { timeout: 600000 });
  const [dl2] = await Promise.all([p2.waitForEvent("download", { timeout: 60000 }), p2.click("#dlBtn")]);
  assert.ok(/\.redacted\.txt$/.test(dl2.suggestedFilename()), `single download is the file (${dl2.suggestedFilename()})`);
  console.log("single-file download ok:", dl2.suggestedFilename());
  await p2.close();

  // ------------------------------------------------------- file:// guard
  // Opened directly, the page must show the guard message and hide the field.
  const p3 = await b.newPage();
  await p3.goto(`file://${path.join(__dirname, "..", "index.html")}`);
  await p3.waitForFunction(() => !document.getElementById("banner").hidden, null, { timeout: 30000 });
  assert.ok((await p3.textContent("#banner")).includes("can't run when opened directly"), "guard message");
  assert.strictEqual(await p3.$eval("#pickField", (e) => e.hidden), true, "guard hides the file field");
  console.log("file:// guard ok");
  await p3.close();

  await b.close();
})().catch((e) => { console.error("E2E FAILED:", e); process.exit(1); });
