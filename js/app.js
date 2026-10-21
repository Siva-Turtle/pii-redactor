import { loadDetector } from "./ai.js";
import { Redactor, buildReportCsv, formatFound } from "./redactor.js";
import { SUPPORTED, extOf, redactFile, detectLock, NeedsPasswordError } from "./handlers.js";

// Fixed pipeline settings (the Options panel was removed from the UI; these
// constants replace it: AI on, thorough check always on, dates hidden, no
// manual list, onlyUnlock off). `?noai=1` is a test-only hook so the e2e can
// exercise the fast pattern-only path; the page offers no AI toggle.
const AI_ON = !new URLSearchParams(location.search).has("noai");
const THOROUGH_ON = true;
const HIDE_DATES = true;
const MANUAL_ITEMS = [];
const ONLY_UNLOCK = false;

window.__appLoaded = true;
const $ = (id) => document.getElementById(id);
// js/guard.js may have shown a "browser can't start" message if loading was slow.
$("banner").hidden = true;

const IDLE_HINT = "Choose one or more files, then press Remove PII.";

let files = []; // current File set (choosing a new set replaces the old one)
let rows = []; // per-file UI state, same order as files
let results = []; // { name, blob, report, fileName } for finished files
let detectorPromise = null;
let reportUrl = null;
let aiFailed = false;

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/* ---------------------------------------------------------------- status
   The status line is the ONLY place the app talks to the user. */

function setStatus(text) {
  $("status").textContent = text;
}

function setBar(fraction) {
  $("bar").hidden = fraction == null;
  if (fraction != null) $("barfill").style.width = `${Math.round(fraction * 100)}%`;
}

function setWarnings(list) {
  const ul = $("warns");
  ul.replaceChildren(...list.map((t) => Object.assign(document.createElement("li"), { textContent: t })));
  ul.hidden = list.length === 0;
}

/* ---------------------------------------------------------------- rows */

function chipFor(status) {
  // Visible chips: Waiting / Needs password / Working / Done / Couldn't process.
  switch (status) {
    case "waiting": return ["Waiting", "waiting"];
    case "needs-pw": return ["Needs password", "waiting"];
    case "working": return ["Working", "working"];
    case "done": return ["Done", "done"];
    default: return ["Couldn't process", "error"];
  }
}

function renderRow(row) {
  const li = row.el;
  const [label, state] = chipFor(row.status);
  const chip = li.querySelector(".chip");
  chip.textContent = label;
  chip.dataset.state = state;
  li.classList.toggle("err", row.status === "error" || !!row.pwError);
  const pw = li.querySelector(".pw");
  pw.hidden = !row.locked;
  const err = li.querySelector(".pwerr");
  err.textContent = row.pwError || "";
  err.hidden = !row.pwError;
}

function addRow(file) {
  const li = document.createElement("li");
  li.className = "frow";
  li.innerHTML = `
    <div class="top"><span class="fname"></span><span class="chip" data-state="waiting">Waiting</span></div>
    <form class="pw" hidden>
      <label></label>
      <input type="password" autocomplete="off">
      <div class="pwerr" hidden></div>
    </form>`;
  li.querySelector(".fname").textContent = file.name;
  const label = li.querySelector(".pw label");
  const input = li.querySelector(".pw input");
  label.textContent = `Password for ${file.name}`;
  label.htmlFor = "";
  input.id = `pw-${Math.random().toString(36).slice(2)}`;
  label.htmlFor = input.id;
  input.setAttribute("aria-label", `Password for ${file.name}`);
  input.addEventListener("input", () => {
    row.pwError = "";
    if (row.status === "error" && row.locked) row.status = "needs-pw";
    renderRow(row);
  });
  const row = { file, el: li, status: "waiting", locked: false, lockFormat: null, pwError: "" };
  li.querySelector(".pw").addEventListener("submit", (e) => {
    e.preventDefault();
    processAll();
  });
  $("files").append(li);
  return row;
}

function setFiles(list) {
  // Choosing a new set replaces the previous set and clears old results.
  if (reportUrl) URL.revokeObjectURL(reportUrl);
  reportUrl = null;
  files = [...list];
  results = [];
  aiFailed = false;
  rows = files.map((f) => addRow(f));
  $("files").replaceChildren(...rows.map((r) => r.el));
  const label = document.querySelector("#pickField .pick-label");
  if (!files.length) {
    label.textContent = "Choose files…";
    label.classList.add("placeholder");
  } else if (files.length === 1) {
    label.textContent = files[0].name;
    label.classList.remove("placeholder");
  } else {
    label.textContent = `${files.length} files`;
    label.classList.remove("placeholder");
  }
  $("dlBtn").disabled = true;
  setStatus(IDLE_HINT);
  setBar(null);
  setWarnings([]);
  $("repBody").replaceChildren();
  $("repMore").hidden = true;
  $("repDl").hidden = true;
  $("ident").open = false;
}

/* ---------------------------------------------------------------- pipeline */

function getDetector() {
  if (!detectorPromise) {
    detectorPromise = loadDetector().catch((err) => {
      console.error(err);
      aiFailed = true;
      return null;
    });
  }
  return detectorPromise;
}

async function processFile(file, row, index, total, password = "") {
  row.status = "working";
  row.pwError = "";
  renderRow(row);
  setBar(0.02);
  try {
    let detector = null;
    if (AI_ON) {
      setStatus(`Working on file ${index + 1} of ${total} (${file.name}): getting the AI ready (first time only)…`);
      detector = await getDetector();
      if (aiFailed) setStatus(`The name-finding AI could not start in this browser, so only the pattern checks (emails, phone numbers, IDs, dates) were used. Continuing file ${index + 1} of ${total} (${file.name})…`);
    }
    const redactor = new Redactor({ dates: HIDE_DATES, thorough: THOROUGH_ON, manual: MANUAL_ITEMS, detector });
    const status = (text) => {
      setStatus(`Working on file ${index + 1} of ${total} (${file.name}): ${text}`);
      const m = text.match(/(\d+) of (\d+)/);
      if (m) setBar(0.05 + 0.9 * (+m[1] / +m[2]));
    };
    const out = await redactFile(file, redactor, status, { password, onlyUnlock: ONLY_UNLOCK });
    // WHY stored in memory only: reports hold the original sensitive text, so
    // they are never saved, never sent anywhere, and never zipped.
    results.push({ name: out.name, blob: out.blob, report: out.report || [], fileName: file.name });
    row.report = out.report || [];
    row.warnings = out.warnings || [];
    row.total = redactor.total;
    row.status = "done";
    row.locked = false;
    renderRow(row);
  } catch (err) {
    if (err instanceof NeedsPasswordError) {
      row.status = "needs-pw";
      row.locked = true;
      renderRow(row);
      return;
    }
    if (err.code === "wrong-password" && password) {
      // Only this row errors; the typed password stays so it is easy to retry.
      row.status = "needs-pw";
      row.locked = true;
      row.pwError = "That password didn't work. Check it and try again.";
      renderRow(row);
      return;
    }
    console.error(err);
    row.status = "error";
    row.failMessage = err.message || String(err);
    renderRow(row);
  }
}

// One run at a time: pressing Enter in a password box while a run is in
// flight (or double-clicking Remove PII) must not start a second run over the
// first — two runs would process the same files twice, duplicate the report
// rows, and leave a stale "Working on…" status. A trigger during a run sets a
// flag; the current run picks the newly typed passwords up on a second pass.
let running = false;
let rerun = false;

async function processAll() {
  if (!files.length) {
    setStatus(IDLE_HINT);
    return;
  }
  if (running) {
    rerun = true;
    return;
  }
  running = true;
  try {
    do {
      rerun = false;
      await processOnce();
    } while (rerun);
  } finally {
    running = false;
  }
}

async function processOnce() {
  // WHY only waiting + needs-pw: a file that ended in error (scan, damaged,
  // unsupported) stays failed for this file set — reprocessing it on every
  // retry would redo slow work and race the status line. Only files that now
  // have a password (needs-pw) or never ran (waiting) go again. Choosing a
  // new set of files resets every row (see setFiles).
  const pending = rows.filter((r) => r.status === "waiting" || r.status === "needs-pw");
  if (!pending.length) return;
  const total = rows.length;
  setBar(0.02);
  setWarnings([]);
  // Classify first so a locked file never blocks the files behind it.
  const jobs = [];
  for (const row of pending) {
    if (!SUPPORTED.includes(extOf(row.file.name))) {
      row.status = "error";
      row.failMessage = "Please use PDF, Word (.docx), Excel, CSV, text or Markdown files.";
      renderRow(row);
      continue;
    }
    if (row.lockedOverride === "open") {
      jobs.push({ row, kind: "open" });
      continue;
    }
    try {
      const res = await detectLock(row.file);
      if (res.kind === "locked") {
        const pw = row.el.querySelector(".pw input").value;
        if (!pw) {
          row.status = "needs-pw";
          row.locked = true;
          renderRow(row);
          continue;
        }
        jobs.push({ row, kind: "locked", password: pw });
      } else if (res.kind === "unsupported") {
        row.status = "error";
        row.failMessage = res.message;
        renderRow(row);
      } else {
        jobs.push({ row, kind: "open" });
      }
    } catch (err) {
      console.error(err);
      row.status = "error";
      row.failMessage = err.message || String(err);
      renderRow(row);
    }
  }
  let n = 0;
  for (const job of jobs) {
    n++;
    const index = rows.indexOf(job.row);
    await processFile(job.row.file, job.row, index, total, job.password || "");
    // A password is never kept: clear the box once the file is done.
    if (job.row.status === "done") {
      job.row.el.querySelector(".pw input").value = "";
      job.row.lockedOverride = job.kind === "locked" ? "open" : job.row.lockedOverride;
    }
  }
  finishRun();
}

function finishRun() {
  setBar(null);
  const done = rows.filter((r) => r.status === "done");
  const needPw = rows.filter((r) => r.status === "needs-pw");
  const failed = rows.filter((r) => r.status === "error");
  // One message composed from parts: sequential setStatus calls would let a
  // per-file failure wipe the wrong-password note (or vice versa), so the
  // status line carries every unfinished thing at once, most urgent first.
  const parts = [];
  // A wrong password names only its file (other rows are untouched).
  const pwFails = rows.filter((r) => r.pwError);
  if (pwFails.length) {
    parts.push(`That password didn't work for ${pwFails[0].file.name}. Check it and try again.`);
  } else if (needPw.length) {
    // Password prompts name the file(s).
    const name = needPw[0].file.name;
    parts.push(needPw.length === 1
      ? `Enter the password for ${name}.`
      : `Enter the passwords for ${needPw.map((r) => r.file.name).join(", ")}.`);
  }
  // Per-file failures reuse the friendly handler messages and name the file.
  const failures = failed.filter((r) => !r.pwError);
  if (failures.length) {
    parts.push(failures.map((r) => `Couldn't process ${r.file.name}: ${r.failMessage}`).join(" "));
  }
  if (done.length) {
    const items = done.reduce((a, r) => a + (r.total || 0), 0);
    parts.push(items > 0
      ? `Done. ${plural(items, "item")} hidden in ${plural(done.length, "file")}. Give the result a quick look before sharing it.`
      : `Done. Nothing sensitive was found in ${plural(done.length, "file")}. Give the result a quick look before sharing it.`);
    $("dlBtn").disabled = false;
    buildCombinedReport();
  }
  if (parts.length) setStatus(parts.join(" "));
  // Per-file warnings that used to sit on cards live here now, as short lines.
  const warns = [];
  if (aiFailed) warns.push("The name-finding AI could not start, so only the pattern checks (emails, phone numbers, IDs, dates) were used.");
  for (const r of done) for (const w of r.warnings || []) warns.push(`${r.file.name}: ${w}`);
  setWarnings(warns);
}

/* ---------------------------------------------------------------- report
   ONE combined table for all files (File, Location, Type, Quote, Found by). */

function rowsFor(report, fileName) {
  return (report || []).map((e) => ({ ...e, file: fileName }));
}

function buildCombinedReport() {
  const all = [];
  for (const { report, fileName } of results) all.push(...rowsFor(report, fileName));
  const CAP = 200;
  const tb = $("repBody");
  tb.replaceChildren();
  for (const e of all.slice(0, CAP)) {
    const tr = document.createElement("tr");
    for (const v of [e.file || "", e.location || "", e.type || "", e.quote || "", formatFound(e)]) {
      const td = document.createElement("td");
      td.textContent = v;
      tr.append(td);
    }
    tb.append(tr);
  }
  const more = $("repMore");
  if (all.length > CAP) {
    more.textContent = `Showing ${CAP} of ${all.length} — download the CSV for the full list.`;
    more.hidden = false;
  } else {
    more.textContent = all.length ? "" : "Nothing was hidden, so the report is empty.";
    more.hidden = !all.length ? false : true;
  }
  // Combined CSV download (UTF-8 with BOM for Excel). Revoked on Start over.
  if (reportUrl) URL.revokeObjectURL(reportUrl);
  const csv = buildReportCsv(all);
  reportUrl = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const dl = $("repDl");
  dl.href = reportUrl;
  dl.download = "pii-report.csv";
  dl.hidden = false;
}

/* ---------------------------------------------------------------- download
   One finished file downloads as that file; two or more download as ONE ZIP
   (redacted files only, never reports; duplicate names handled). */

async function downloadResults() {
  if (!results.length) return;
  if (results.length === 1) {
    const { name, blob } = results[0];
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    return;
  }
  const zip = new JSZip();
  const used = new Set();
  // WHY only redacted files: the reports hold the original sensitive text and
  // must never travel with the redacted files. Use the report download instead.
  for (const { name, blob } of results) {
    let n = name;
    for (let i = 2; used.has(n); i++) n = name.replace(/(\.[^.]+)$/, ` (${i})$1`);
    used.add(n);
    zip.file(n, blob);
  }
  const blob = await zip.generateAsync({ type: "blob" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "pii-removed-files.zip" });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/* ---------------------------------------------------------------- events */

$("picker").addEventListener("change", (e) => {
  setFiles(e.target.files);
  e.target.value = "";
});
const field = $("pickField");
field.addEventListener("click", () => $("picker").click());
for (const ev of ["dragenter", "dragover"]) {
  field.addEventListener(ev, (e) => {
    e.preventDefault();
    field.classList.add("over");
  });
}
for (const ev of ["dragleave", "drop"]) {
  field.addEventListener(ev, (e) => {
    e.preventDefault();
    field.classList.remove("over");
  });
}
field.addEventListener("drop", (e) => setFiles(e.dataTransfer.files));
// A file dropped outside the field must not make the browser open it (and show it unredacted).
for (const ev of ["dragover", "drop"]) window.addEventListener(ev, (e) => e.preventDefault());

$("removeBtn").addEventListener("click", processAll);
$("dlBtn").addEventListener("click", downloadResults);

/*
hidden by design: Options removed from UI; backend still supports it.
The previous version wired five option controls into the pipeline and gave
every file its own card with per-file download/report buttons plus global
"Download all as ZIP" / "Download all reports (.csv)" / "Start over" buttons:

  const redactor = new Redactor({ dates: $("optDates").checked,
    thorough: $("optThorough").checked, manual: parseManual($("optManual").value),
    detector });
  const out = await redactFile(file, redactor, status,
    { password, onlyUnlock: $("optOnlyUnlock").checked });
  // per-card: download(blob, name), reportDownload(csvBlob, name),
  //   showReport(report) with its own collapsed "What was hidden (N items)",
  //   lock()/unlock() around the inline password box, queue serialisation so a
  //   locked file never blocked the files behind it.
  $("zipAll").addEventListener("click", ...);       // redacted-files.zip
  $("dlReports").addEventListener("click", ...);    // redaction-reports.csv
  $("reset").addEventListener("click", ...);        // revoked URLs, cleared cards
  if ($("optAi").checked) detector = await getDetector();

To re-enable: restore the <details> Options block and the per-file actions in
index.html (see the HTML comment there), then rewire the lines above. The
backend (Redactor manual list, onlyUnlock handler paths, buildReportCsv) is
untouched in js/redactor.js and js/handlers.js.
*/
