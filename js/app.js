import { loadDetector } from "./ai.js";
import { Redactor } from "./redactor.js";
import { SUPPORTED, extOf, redactFile } from "./handlers.js";

const $ = (id) => document.getElementById(id);
const LABELS = {
  NAME: "name", ADDRESS: "address", EMAIL: "email", UPI: "UPI ID", PHONE: "phone number", PAN: "PAN",
  AADHAAR: "Aadhaar", SSN: "SSN", CARD: "card number", IFSC: "IFSC", GSTIN: "GSTIN", ACCOUNT: "account number",
  DATE: "date", IP: "IP address", ID: "ID number",
};
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

const results = []; // { name, blob }
let detectorPromise = null;
let queue = Promise.resolve();

function showBanner(id, text) {
  $(id).textContent = text;
  $(id).hidden = !text;
}

if (location.protocol === "file:") {
  showBanner(
    "banner",
    "This page needs to be opened with the start file. Close this tab and double-click “Start” (Windows: Start-Windows.bat, Mac: Start-Mac.command) in the folder.",
  );
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
    <div class="actions" hidden></div>`;
  li.querySelector(".fname").textContent = file.name;
  $("files").append(li);
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
    download: (blob, name) => {
      const box = li.querySelector(".actions");
      const a = document.createElement("a");
      a.className = "btn";
      a.textContent = "Download redacted file";
      a.href = URL.createObjectURL(blob);
      a.download = name;
      box.replaceChildren(a);
      box.hidden = false;
    },
  };
}

function summarise(counts) {
  const parts = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([type, n]) => plural(n, LABELS[type] || type.toLowerCase()));
  return parts.join(", ");
}

async function processFile(file) {
  const card = addCard(file);
  if (!SUPPORTED.includes(extOf(file.name))) {
    card.state("Not supported", "err");
    card.notes(["Please use PDF, Word (.docx), Excel, CSV, text or Markdown files."]);
    return;
  }
  try {
    card.state("Working…");
    card.progress(0.02);
    let detector = null;
    if ($("optAi").checked) {
      card.state("Getting the AI ready (first time only)…");
      detector = await getDetector();
    }
    const redactor = new Redactor({ dates: $("optDates").checked, detector });
    const status = (text) => {
      card.state(text);
      const m = text.match(/(\d+) of (\d+)/);
      if (m) card.progress(0.05 + 0.9 * (+m[1] / +m[2]));
    };
    const out = await redactFile(file, redactor, status);
    results.push(out);
    card.progress(null);
    card.state("Done", "ok");
    card.found(redactor.total ? `Hid ${plural(redactor.total, "item")}: ${summarise(redactor.counts)}` : "Nothing sensitive was found.");
    card.notes(out.warnings);
    card.download(out.blob, out.name);
    $("zipAll").hidden = results.length < 2;
  } catch (err) {
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
  // One file at a time: the AI model is single-threaded and big files are memory hungry.
  for (const f of files) queue = queue.then(() => processFile(f));
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
  for (const { name, blob } of results) {
    let n = name;
    for (let i = 2; used.has(n); i++) n = name.replace(/(\.[^.]+)$/, ` (${i})$1`);
    used.add(n);
    zip.file(n, blob);
  }
  const blob = await zip.generateAsync({ type: "blob" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "redacted-files.zip" });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});

$("reset").addEventListener("click", () => {
  for (const a of document.querySelectorAll("#files a.btn")) URL.revokeObjectURL(a.href);
  results.length = 0;
  $("files").replaceChildren();
  $("actions").hidden = true;
  $("zipAll").hidden = true;
});
