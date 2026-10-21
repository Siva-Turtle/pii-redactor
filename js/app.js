import { loadDetector } from "./ai.js";
import { Redactor, parseManual, buildReportCsv, formatFound } from "./redactor.js";
import { SUPPORTED, extOf, redactFile, detectLock, NeedsPasswordError } from "./handlers.js";

window.__appLoaded = true;
const $ = (id) => document.getElementById(id);
// js/guard.js may have shown a "browser can't start" message if loading was slow.
$("banner").hidden = true;
$("drop").hidden = false;
const LABELS = {
  NAME: "name", ADDRESS: "address", EMAIL: "email", UPI: "UPI ID", PHONE: "phone number", PAN: "PAN",
  AADHAAR: "Aadhaar", SSN: "SSN", CARD: "card number", IFSC: "IFSC", GSTIN: "GSTIN", ACCOUNT: "account number",
  DATE: "date", IP: "IP address", ID: "ID number", CUSTOM: "item from your list", PII: "other private detail", DEMAT: "demat account", FOLIO: "folio number",
  POLICY: "policy/UAN/PRAN number", SECRET: "password/PIN/OTP", TAN: "TAN",
};
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

const results = []; // { name, blob, report, fileName }
let detectorPromise = null;
let queue = Promise.resolve();

const REPORT_URLS = []; // WHY tracked: Start over must revoke every object URL, incl. reports.
function trackUrl(url) {
  REPORT_URLS.push(url);
  return url;
}

function reportFileName(outName) {
  return outName.replace(/\.[^.]+$/, "") + ".report.csv";
}

/** Rows for the CSV: the stored report plus which original file each row came from. */
function rowsFor(report, fileName) {
  return (report || []).map((e) => ({ ...e, file: fileName }));
}

function showBanner(id, text) {
  $(id).textContent = text;
  $(id).hidden = !text;
}

function getDetector() {
  if (!detectorPromise) {
    detectorPromise = loadDetector().catch((err) => {
      console.error(err);
      showBanner("aiNote", "The name-finding AI could not start in this browser, so only the pattern checks (emails, phone numbers, IDs, dates) were used.");
      return null;
    });
  }
  return detectorPromise;
}

function addCard(file) {
  const li = document.createElement("li");
  li.className = "file";
  li.innerHTML = `
    <div class="row"><span class="fname"></span><span class="state">Waiting…</span></div>
    <div class="bar" hidden><div></div></div>
    <div class="found" hidden></div>
    <ul class="notes" hidden></ul>
    <form class="pw" hidden>
      <div class="pwhint"></div>
      <div class="pwrow">
        <input type="password" autocomplete="off" aria-label="File password" placeholder="Type the file password">
        <button type="submit">Unlock</button>
      </div>
      <div class="pwerr" hidden></div>
    </form>
    <div class="actions" hidden></div>
    <details class="rep" hidden>
      <summary></summary>
      <p class="repwarn">This report lists the original sensitive text that was hidden. Keep it private — never send it along with the redacted file.</p>
      <div class="repwrap"></div>
      <div class="repmore" hidden></div>
    </details>`;
  li.querySelector(".fname").textContent = file.name;
  $("files").append(li);
  const pwForm = li.querySelector(".pw");
  const pwInput = li.querySelector(".pw input");
  const pwErr = li.querySelector(".pwerr");
  const repEl = li.querySelector(".rep");
  const repSummary = li.querySelector(".rep summary");
  const repWrap = li.querySelector(".repwrap");
  const repMore = li.querySelector(".repmore");
  return {
    state: (text, cls = "") => {
      const s = li.querySelector(".state");
      s.textContent = text;
      s.className = `state ${cls}`;
    },
    progress: (fraction) => {
      li.querySelector(".bar").hidden = fraction == null;
      if (fraction != null) li.querySelector(".bar > div").style.width = `${Math.round(fraction * 100)}%`;
    },
    found: (text) => {
      const f = li.querySelector(".found");
      f.textContent = text;
      f.hidden = !text;
    },
    notes: (list) => {
      const ul = li.querySelector(".notes");
      ul.replaceChildren(...list.map((t) => Object.assign(document.createElement("li"), { textContent: t })));
      ul.hidden = list.length === 0;
    },
    download: (blob, name, label = "Download redacted file") => {
      const box = li.querySelector(".actions");
      const a = document.createElement("a");
      a.className = "btn";
      a.textContent = label;
      a.href = trackUrl(URL.createObjectURL(blob));
      a.download = name;
      box.replaceChildren(a);
      box.hidden = false;
      return a;
    },
    reportDownload: (blob, name, label = "Download report (.csv)") => {
      const box = li.querySelector(".actions");
      const a = document.createElement("a");
      a.className = "btn secondary repdl";
      a.textContent = label;
      a.href = trackUrl(URL.createObjectURL(blob));
      a.download = name;
      box.append(a);
      box.hidden = false;
      return a;
    },
    showReport: (report, fileName) => {
      const n = (report || []).length;
      repSummary.textContent = n ? `What was hidden (${n} items)` : "What was hidden (0 items)";
      repWrap.replaceChildren();
      if (n) {
        const table = document.createElement("table");
        const thead = document.createElement("thead");
        const hr = document.createElement("tr");
        for (const h of ["Location", "Type", "Quote", "Found by"]) {
          const th = document.createElement("th");
          th.textContent = h;
          hr.append(th);
        }
        thead.append(hr);
        table.append(thead);
        const tb = document.createElement("tbody");
        const CAP = 200;
        for (const e of (report || []).slice(0, CAP)) {
          const tr = document.createElement("tr");
          for (const v of [e.location || "", e.type || "", e.quote || "", formatFound(e)]) {
            const td = document.createElement("td");
            td.textContent = v;
            tr.append(td);
          }
          tb.append(tr);
        }
        table.append(tb);
        repWrap.append(table);
        if (n > CAP) {
          repMore.textContent = `Showing first ${CAP} of ${n} — download the CSV for the full list.`;
          repMore.hidden = false;
        } else {
          repMore.hidden = true;
        }
      } else {
        const p = document.createElement("p");
        p.textContent = "Nothing was hidden, so the report is empty.";
        repWrap.append(p);
        repMore.hidden = true;
      }
      repEl.hidden = false;
    },
    // Shows the inline password box. onUnlock receives the typed password and
    // runs when the user clicks Unlock or presses Enter. The form stays on the
    // card across retries; it is removed once the file is unlocked.
    lock: (hint, onUnlock) => {
      li.querySelector(".pwhint").textContent = hint;
      pwErr.hidden = true;
      pwForm.hidden = false;
      pwInput.disabled = false;
      pwForm.querySelector("button").disabled = false;
      pwForm.onsubmit = (e) => {
        e.preventDefault();
        onUnlock(pwInput.value);
      };
    },
    pwError: (text) => {
      pwErr.textContent = text;
      pwErr.hidden = !text;
    },
    locking: (busy) => {
      pwInput.disabled = busy;
      pwForm.querySelector("button").disabled = busy;
    },
    unlocked: () => {
      // The password is never stored: clear the box and drop the form so no
      // reference to it survives in the page.
      pwInput.value = "";
      pwForm.hidden = true;
      pwForm.onsubmit = null;
    },
  };
}

function summarise(counts) {
  const parts = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([type, n]) => plural(n, LABELS[type] || type.toLowerCase()));
  return parts.join(", ");
}

const LOCK_HINT =
  "This file is protected with a password. Type it to continue — the password stays on this computer and is never saved.";

// Ask for the password inline on the card. Nothing is queued: other files
// keep processing while this one waits, and work resumes on Unlock/Enter.
function showLock(card, file, format) {
  card.state("Needs a password");
  card.lock(LOCK_HINT, (password) => {
    if (!password) {
      card.pwError("Type the password first.");
      return;
    }
    card.pwError("");
    card.locking(true);
    card.state("Unlocking…");
    card.progress(0.02);
    // The password lives only in this closure; unlock() clears the box and
    // the reference is dropped when processing finishes.
    queue = queue.then(() => processFile(file, card, password));
  });
}

async function processFile(file, card, password = "") {
  try {
    card.state("Working…");
    card.progress(0.02);
    let detector = null;
    if ($("optAi").checked) {
      card.state("Getting the AI ready (first time only)…");
      detector = await getDetector();
    }
    const redactor = new Redactor({ dates: $("optDates").checked, thorough: $("optThorough").checked, manual: parseManual($("optManual").value), detector });
    const status = (text) => {
      card.state(text);
      const m = text.match(/(\d+) of (\d+)/);
      if (m) card.progress(0.05 + 0.9 * (+m[1] / +m[2]));
    };
    const out = await redactFile(file, redactor, status, { password, onlyUnlock: $("optOnlyUnlock").checked });
    // WHY store the report in memory only: it holds the original sensitive
    // text, so it is never saved, never sent anywhere, and never zipped.
    const report = out.report || [];
    results.push({ name: out.name, blob: out.blob, report, fileName: file.name });
    card.unlocked();
    card.progress(null);
    card.state("Done", "ok");
    // The checkbox only changes behaviour for files that had a password.
    const onlyRemoved = !!password && $("optOnlyUnlock").checked;
    card.found(
      onlyRemoved
        ? "Password removed."
        : redactor.total
          ? `Hid ${plural(redactor.total, "item")}: ${summarise(redactor.counts)}`
          : "Nothing sensitive was found.",
    );
    card.notes(out.warnings);
    card.download(out.blob, out.name, onlyRemoved ? "Download unlocked file" : "Download redacted file");
    // Per-file report CSV (UTF-8 with BOM for Excel). Revoked on Start over.
    const csv = buildReportCsv(rowsFor(report, file.name));
    const csvBlob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    card.reportDownload(csvBlob, reportFileName(out.name));
    card.showReport(report, file.name);
    $("zipAll").hidden = results.length < 2;
    $("dlReports").hidden = results.length < 1;
  } catch (err) {
    if (err instanceof NeedsPasswordError) {
      card.progress(null);
      showLock(card, file);
      return;
    }
    if (err.code === "wrong-password" && password) {
      // Back to the password box so the user can retry; the queue is free.
      // The typed password is left in place so a small typo is easy to fix.
      card.progress(null);
      showLock(card, file);
      card.pwError(err.message);
      card.state("Needs a password");
      return;
    }
    console.error(err);
    card.progress(null);
    card.state("Could not redact this file", "err");
    card.notes([err.message || String(err)]);
  }
}

function handleFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  $("actions").hidden = false;
  for (const f of files) {
    const card = addCard(f);
    if (!SUPPORTED.includes(extOf(f.name))) {
      card.state("Not supported", "err");
      card.notes(["Please use PDF, Word (.docx), Excel, CSV, text or Markdown files."]);
      continue;
    }
    // Classify without touching the queue, so a locked file never blocks the
    // files behind it. Only actual redaction work is serialised.
    card.state("Checking…");
    detectLock(f).then(
      (res) => {
        if (res.kind === "locked") showLock(card, f, res.format);
        else if (res.kind === "unsupported") {
          card.state("Could not redact this file", "err");
          card.notes([res.message]);
        } else {
          queue = queue.then(() => processFile(f, card));
        }
      },
      (err) => {
        console.error(err);
        card.state("Could not redact this file", "err");
        card.notes([err.message || String(err)]);
      },
    );
  }
}

$("picker").addEventListener("change", (e) => {
  handleFiles(e.target.files);
  e.target.value = "";
});
const drop = $("drop");
for (const ev of ["dragenter", "dragover"])
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.add("over");
  });
for (const ev of ["dragleave", "drop"])
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.remove("over");
  });
drop.addEventListener("drop", (e) => handleFiles(e.dataTransfer.files));
// A file dropped outside the box must not make the browser open it (and show it unredacted).
for (const ev of ["dragover", "drop"]) window.addEventListener(ev, (e) => e.preventDefault());

$("zipAll").addEventListener("click", async () => {
  const zip = new JSZip();
  const used = new Set();
  // WHY only redacted files: the reports hold the original sensitive text and
  // must never travel with the redacted files. Use "Download all reports" instead.
  for (const { name, blob } of results) {
    let n = name;
    for (let i = 2; used.has(n); i++) n = name.replace(/(\.[^.]+)$/, ` (${i})$1`);
    used.add(n);
    zip.file(n, blob);
  }
  const blob = await zip.generateAsync({ type: "blob" });
  const a = Object.assign(document.createElement("a"), { href: trackUrl(URL.createObjectURL(blob)), download: "redacted-files.zip" });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});

$("dlReports").addEventListener("click", () => {
  const all = [];
  for (const { report, fileName } of results) all.push(...rowsFor(report, fileName));
  const csv = buildReportCsv(all);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const a = Object.assign(document.createElement("a"), { href: trackUrl(URL.createObjectURL(blob)), download: "redaction-reports.csv" });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});

$("reset").addEventListener("click", () => {
  for (const u of REPORT_URLS) URL.revokeObjectURL(u);
  REPORT_URLS.length = 0;
  for (const a of document.querySelectorAll("#files a.btn")) URL.revokeObjectURL(a.href);
  results.length = 0;
  $("files").replaceChildren();
  $("actions").hidden = true;
  $("zipAll").hidden = true;
  $("dlReports").hidden = true;
});
