// One handler per file type. Each takes the file's bytes plus a Redactor and
// returns { blob, name, warnings }. Everything runs in the browser; nothing is
// uploaded. Globals JSZip, XLSX and PDFLib come from the <script> tags in
// index.html; pdf.js is imported as a module.

import { parseCsv, stringifyCsv, detectDelimiter } from "./csv.js";
import { labelFor } from "./patterns.js";
import { LLM_NOTICE } from "./notice.js";
import { ocrCanvas, boxesForSpans, blacken, scaleBox, embeddedImageRects, cropForOcr } from "./ocr.js";
import {
  unlockOffice,
  detectOfficeEncryption,
  WrongPasswordError,
  UnsupportedEncryptionError,
} from "./office-crypto.js";

// Thorough mode costs roughly 10 s per paragraph, so the AI pass is time-boxed per file.
const AI_TIME_BUDGET_MS = 10 * 60 * 1000;

export const SUPPORTED = ["pdf", "xlsx", "xls", "csv", "txt", "md", "docx", "jpg", "jpeg", "png", "webp"];

export const extOf = (name) => (name.split(".").pop() || "").toLowerCase();

// ------------------------------------------------------------------ passwords
// A locked file never goes through the redaction queue until the user unlocks
// it (see app.js). detectLock classifies a freshly dropped file:
//   { kind: "open" }                                    normal path
//   { kind: "locked", format: "pdf"|"office", bytes }   show the password box
//   { kind: "unsupported", message }                     explain, no retry
// bytes are returned only for locked files, so the unlock step can proceed
// without re-reading the disk and the password need never touch the queue.
export async function detectLock(file) {
  const ext = extOf(file.name);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (ext === "pdf") {
    const lib = await loadPdfjs();
    try {
      const doc = await lib.getDocument({ data: bytes, isEvalSupported: false }).promise;
      await doc.destroy();
      return { kind: "open" };
    } catch (err) {
      if (err instanceof NeedsPasswordError || err?.name === "PasswordException") return { kind: "locked", format: "pdf", bytes };
      return { kind: "open" }; // damaged etc: the normal path reports it kindly
    }
  }
  if (ext === "docx" || ext === "xlsx" || ext === "xls" || ext === "doc") {
    const kind = detectOfficeEncryption(bytes, ext);
    if (kind === "agile") return { kind: "locked", format: "office", bytes };
    if (kind === "standard" || kind === "extensible") {
      return {
        kind: "unsupported",
        message:
          "This file uses an older kind of Office password protection that this tool can't open. " +
          "Open it in Word or Excel and re-save it without a password, then drop it in again.",
      };
    }
    if (kind === "legacy") {
      return {
        kind: "unsupported",
        message:
          "This is a very old Word/Excel 97–2003 file with password protection, which this tool can't open. " +
          "Open it in Word or Excel and save it as .docx/.xlsx without a password, then drop it in again.",
      };
    }
    return { kind: "open" };
  }
  return { kind: "open" };
}

// Unlock an Office file's bytes with the user's password (sync; ~1 s for the
// 100000-round key check). Throws WrongPasswordError on a bad password.
function unlockedFile(file, bytes, password) {
  const zip = unlockOffice(bytes, password);
  return { name: file.name, arrayBuffer: async () => zip };
}

const OFFICE_MIME = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function outName(name, ext) {
  const base = name.replace(/\.[^.]+$/, "");
  return `${base}.redacted.${ext}`;
}

// Spreadsheet column headers that look like names but describe something else
// (files, companies, banks, places…). These must never trigger whole-column hiding.
const NAME_HEADER_BLOCK =
  /file|sheet|company|bank|scheme|fund|product|plan|branch|city|state|country|nick|user|business|organi[sz]ation|entity|employer/i;

// Template / finance words that sit in a "Name" column but are not people.
// WHY a set: a header such as "Name" or "Goal Name" hides the whole column,
// so labels like Self/Spouse/Salary/Total Expenses must veto the hiding.
export const LABEL_WORDS = new Set([
  "self", "spouse", "child", "children", "father", "mother", "son", "daughter",
  "brother", "sister", "husband", "wife", "family", "total", "totals", "pan",
  "current", "advisor", "adviser", "client", "investor", "customer", "applicant",
  "holder", "name", "salary", "rent", "utilities", "expense", "expenses", "income",
  "goal", "goals", "asset", "assets", "liability", "liabilities", "category",
  "categories", "item", "items", "head", "particular", "particulars", "insurance",
  "loan", "investment", "investments", "transaction", "transactions", "description",
  "type", "label", "fund", "scheme", "plan", "branch", "amount", "balance",
  "quantity", "number", "date", "note", "notes", "period", "statement",
]);
// Full-phrase labels (multi-word) that are never names even though each word is capitalised.
const LABEL_PHRASES = new Set([
  "statement period",
  "account holder",
  "client name",
  "account holder name",
]);

// A "Name:" label in one cell with the real name in the cell to its right
// (key-value layouts). The label itself stays visible; the neighbour is hidden.
export const NAME_LABEL_RE =
  /^(?:client|investor|account holder|holder|applicant|customer)?\s*name\s*:?$/i;

/** True when a data cell looks like a person's name: 1-4 capitalised alphabetic words. */
export function isNameLike(cell) {
  const text = String(cell ?? "").trim();
  if (!text) return false;
  const norm = text.toLowerCase().replace(/\s+/g, " ").replace(/\s*:\s*$/, "");
  if (LABEL_WORDS.has(norm) || LABEL_PHRASES.has(norm)) return false;
  if (/[0-9&]/.test(text)) return false;
  const words = text.split(/\s+/);
  if (words.length < 1 || words.length > 4) return false;
  for (const w of words) {
    if (w.length < 2) return false;
    if (!/^[A-Za-z][A-Za-z'’-]*$/.test(w)) return false;
    if (!/^[A-Z]/.test(w)) return false;
    if (LABEL_WORDS.has(w.toLowerCase())) return false;
  }
  return true;
}

/**
 * WHY shared: CSV and XLSX must agree on when a NAME column is really people.
 * Hide the column only when at least half of its non-empty data cells are name-shaped;
 * otherwise leave the cells to the normal pattern/AI path.
 */
export function shouldHideNameColumn(cells) {
  const vals = (cells || []).map((c) => String(c ?? "").trim()).filter(Boolean);
  if (!vals.length) return false;
  const hits = vals.filter(isNameLike).length;
  return hits / vals.length >= 0.5;
}

/** Non-empty, non-numeric cells are name candidates for the key-value rule. */
export function isHidableValue(cell) {
  const text = String(cell ?? "").trim();
  if (!text) return false;
  if (/[0-9]/.test(text)) return false;
  return true;
}
export function headerType(header) {
  const h = String(header ?? "").trim();
  if (!h) return null;
  if (/e-?mail/i.test(h)) return "EMAIL";
  if (/phone|mobile|whats\s?app|contact\s*(no|num)|\btel\b/i.test(h)) return "PHONE";
  if (/\bdob\b|birth/i.test(h)) return "DATE";
  if (/address|street|locality|pin\s*code|postal|\bzip/i.test(h)) return "ADDRESS";
  if (/password|passcode|\bpin\b|\botp\b|\bcvv\b/i.test(h)) return "SECRET";
  if (/demat|\bbo\s*id|\bdp\s*id|client\s*id/i.test(h)) return "DEMAT";
  if (/folio/i.test(h)) return "FOLIO";
  if (/policy\s*(no|num)|\bpran\b|\buan\b|\bckyc\b/i.test(h)) return "POLICY";
  if (/\b(pan|aadhaa?r|ssn|passport|gstin|tan|voter|epic|itin)\b/i.test(h)) return "ID";
  if (/account|a\/c|\bacct\b|\bifsc\b|\bmicr\b|\bswift\b|\biban\b|routing|card\s*(no|num)|cif\b|customer\s*id|loan\s*(no|num|id)|cheque/i.test(h))
    return "ACCOUNT";
  if (
    /name/i.test(h) &&
    !NAME_HEADER_BLOCK.test(h)
  )
    return "NAME";
  return null;
}

// Reports often start with a title or blank rows above the real headers. The
// header row is the first of the top rows that has 2+ filled cells, at least one
// of them a recognisable header; otherwise row 0.
export function findHeaderRow(rows) {
  for (let r = 0; r < Math.min(rows.length, 15); r++) {
    const cells = rows[r].map((c) => String(c ?? "").trim());
    if (cells.filter(Boolean).length >= 2 && cells.some((c) => headerType(c))) return r;
  }
  return 0;
}

async function learnWithBudget(redactor, texts, status, warnings) {
  // WHY still learn without AI: pattern-found IDs (demat/folio/account) must
  // propagate file-wide even in regex-only mode, so learn() always runs.
  if (!redactor.detector) {
    await redactor.learn(texts, {});
    return;
  }
  const r = await redactor.learn(texts, {
    maxMs: AI_TIME_BUDGET_MS,
    onProgress: (i, n) => status(`Looking for names and addresses… ${i} of ${n}`),
  });
  if (r.truncated) {
    warnings.push(
      `This file is large, so the AI had time for the first ${r.scanned} of ${r.total} sections. ` +
        `Emails, phone numbers, ID numbers and dates were checked everywhere. Please skim the result for stray names.`,
    );
  }
}

// WHY one helper for all formats: Redactor.report entries are created without
// a location; each handler stamps the entries its own step just added.
function tagReport(redactor, base, location, page = "") {
  for (let i = base; i < redactor.report.length; i++) {
    if (!redactor.report[i].location) redactor.report[i].location = location;
    if (!redactor.report[i].page && page !== "") redactor.report[i].page = page;
  }
}

const lineOf = (text, index) => text.slice(0, index).split("\n").length;

// ---------------------------------------------------------------- text / md
async function redactText(file, redactor, status, ext) {
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await file.arrayBuffer());
  const warnings = [];
  await learnWithBudget(redactor, [text], status, warnings);
  const base = redactor.report.length;
  const out = redactor.apply(text);
  // Closing notice for any LLM that later reads the file, as real text.
  const outWithNotice = out.replace(/\s*$/, "") + "\n\n" + LLM_NOTICE + "\n";
  for (let i = base; i < redactor.report.length; i++) {
    const e = redactor.report[i];
    e.location = `line ${e.start != null ? lineOf(text, e.start) : 1}`;
    e.page = "";
  }
  return { blob: new Blob([outWithNotice], { type: "text/plain" }), name: outName(file.name, ext), warnings, report: redactor.report.slice() };
}

// --------------------------------------------------------------------- csv
async function redactCsv(file, redactor, status) {
  // ignoreBOM keeps the byte-order mark so it can be written back (Excel needs it to read
  // non-English text in a CSV correctly).
  let text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await file.arrayBuffer());
  const bom = text.charCodeAt(0) === 0xfeff ? "\ufeff" : "";
  text = text.replace(/^\ufeff/, "");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const delimiter = detectDelimiter(text);
  const rows = parseCsv(text, delimiter);
  const warnings = [];
  const headRow = findHeaderRow(rows);
  const hidden = (rows[headRow] || []).map(headerType);
  // WHY prune: a "Name" header over template labels (Self, Salary, Total
  // Expenses…) is not people. Keep the column only when half the data looks like names.
  for (let c = 0; c < hidden.length; c++) {
    if (hidden[c] !== "NAME") continue;
    const colCells = [];
    for (let r = headRow + 1; r < rows.length; r++) colCells.push(rows[r][c] ?? "");
    if (!shouldHideNameColumn(colCells)) hidden[c] = null;
  }
  // Key-value layouts: "Name" in one cell, the real name in the cell to its right.
  // The label stays visible; the neighbour is hidden as NAME.
  const kvTarget = new Map();
  const kvLabel = new Set();
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] || [];
    for (let c = 0; c < row.length; c++) {
      if (!NAME_LABEL_RE.test(String(row[c] ?? "").trim())) continue;
      const next = row[c + 1];
      if (next === undefined || !isHidableValue(next)) continue;
      if (r === headRow && headerType(next)) continue; // real table header, not key-value
      kvTarget.set(`${r}:${c + 1}`, String(row[c] ?? "").trim());
      kvLabel.add(`${r}:${c}`);
    }
  }

  const rowText = (row, r) =>
    row.filter((cell, c) => !hidden[c] && !kvTarget.has(`${r}:${c}`) && /\p{L}{3,}/u.test(cell)).join(" | ");
  await learnWithBudget(redactor, rows.map((row, r) => (r === headRow ? "" : rowText(row, r))), status, warnings);

  // Rows above the header are titles: they still go through the patterns/AI.
  const headNames = rows[headRow] || [];
  const out = rows.map((row, r) => {
    if (r === headRow && ![...kvTarget.keys()].some((k) => k.startsWith(`${r}:`))) return row;
    return row.map((cell, c) => {
      const header = headNames[c] ?? "";
      const loc = r > headRow && header
        ? `row ${r + 1}, column "${header}"`
        : `row ${r + 1}, column ${c + 1}`;
      if (kvLabel.has(`${r}:${c}`)) return cell; // never hide the "Name" label itself
      if (kvTarget.has(`${r}:${c}`)) {
        if (!cell) return cell;
        const base = redactor.report.length;
        const outCell = redactor.hideAs("NAME", cell, kvTarget.get(`${r}:${c}`));
        tagReport(redactor, base, loc);
        return outCell;
      }
      if (r === headRow) return cell; // headers stay readable; only key-value targets above are hidden
      if (r > headRow && hidden[c] === "NAME") {
        if (cell && isNameLike(cell)) {
          const base = redactor.report.length;
          const outCell = redactor.hideAs(hidden[c], cell, header);
          tagReport(redactor, base, loc);
          return outCell;
        }
        // Not name-shaped (Self, Salary, Total Expenses…): normal pattern/AI path.
      } else if (r > headRow && hidden[c]) {
        const base = redactor.report.length;
        const outCell = cell ? redactor.hideAs(hidden[c], cell, header) : cell;
        tagReport(redactor, base, loc);
        return outCell;
      }
      const base = redactor.report.length;
      const outCell = redactor.apply(cell);
      tagReport(redactor, base, loc);
      return outCell;
    });
  });
  const hiddenCols = (rows[headRow] || []).filter((_, c) => hidden[c]);
  if (hiddenCols.length) warnings.push(`Hid whole columns: ${hiddenCols.join(", ")}.`);
  return {
    blob: new Blob([bom + stringifyCsv([...out, [LLM_NOTICE]], delimiter, eol)], { type: "text/csv" }),
    name: outName(file.name, "csv"),
    warnings,
    report: redactor.report.slice(),
  };
}

// -------------------------------------------------------------------- xlsx
async function redactXlsx(file, redactor, status, opts = {}) {
  if (opts.password) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (opts.onlyUnlock) {
      const zip = unlockOffice(bytes, opts.password);
      return {
        blob: new Blob([zip], { type: OFFICE_MIME.xlsx }),
        name: file.name,
        warnings: ["Password removed. The file is otherwise unchanged.", "Report is empty: only the password was removed, nothing was hidden."],
        report: [],
      };
    }
    file = unlockedFile(file, bytes, opts.password);
  }
  const wb = XLSX.read(await file.arrayBuffer(), { type: "array", cellStyles: true });
  const warnings = [];
  const plan = [];
  const learnTexts = [];

  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    if (!sheet || !sheet["!ref"]) continue;
    const range = XLSX.utils.decode_range(sheet["!ref"]);
    const textAt = (r, c) => {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })];
      return cell ? String(cell.w ?? cell.v ?? "") : "";
    };
    const grid = [];
    for (let r = range.s.r; r <= Math.min(range.e.r, range.s.r + 14); r++) {
      const row = [];
      for (let c = range.s.c; c <= range.e.c; c++) row.push(textAt(r, c));
      grid.push(row);
    }
    const headR = range.s.r + findHeaderRow(grid);
    const hidden = {};
    for (let c = range.s.c; c <= range.e.c; c++) hidden[c] = headerType(textAt(headR, c));
    // WHY prune via the shared helper: a "Name" header over Self/Salary/Total
    // Expenses… is not people. Same rule as CSV.
    for (let c = range.s.c; c <= range.e.c; c++) {
      if (hidden[c] !== "NAME") continue;
      const colCells = [];
      for (let r = headR + 1; r <= range.e.r; r++) colCells.push(textAt(r, c));
      if (!shouldHideNameColumn(colCells)) hidden[c] = null;
    }
    // Key-value layouts: "Name" in one cell, the real name to its right.
    const kvTargets = new Map();
    const kvLabels = new Set();
    for (let r = range.s.r; r <= range.e.r; r++) {
      for (let c = range.s.c; c <= range.e.c; c++) {
        if (!NAME_LABEL_RE.test(textAt(r, c).trim())) continue;
        if (c + 1 > range.e.c || !isHidableValue(textAt(r, c + 1))) continue;
        if (r === headR && headerType(textAt(r, c + 1))) continue; // real table header
        kvTargets.set(`${r},${c + 1}`, textAt(r, c).trim());
        kvLabels.add(`${r},${c}`);
      }
    }
    for (let r = range.s.r; r <= range.e.r; r++) {
      const rowBits = [];
      for (let c = range.s.c; c <= range.e.c; c++) {
        const addr = XLSX.utils.encode_cell({ r, c });
        const cell = sheet[addr];
        if (!cell) continue;
        const asText = String(cell.w ?? cell.v ?? "");
        const isHeaderRow = r === headR;
        const key = `${r},${c}`;
        let cellHidden = r > headR ? hidden[c] : null;
        let cellHeader = r > headR ? textAt(headR, c) : "";
        if (kvLabels.has(key)) {
          cellHidden = null; // never hide the "Name" label itself
        } else if (kvTargets.has(key)) {
          cellHidden = "NAME"; // shared helper rule: hide the neighbour as NAME
          cellHeader = kvTargets.get(key);
        } else if (cellHidden === "NAME" && !isNameLike(asText)) {
          cellHidden = null; // template label: leave to the pattern/AI path
        }
        // Header-row key-value targets still hide even though headers normally stay.
        if (isHeaderRow && kvTargets.has(key)) {
          cellHidden = "NAME";
          cellHeader = kvTargets.get(key);
        }
        plan.push({
          cell, asText,
          hidden: cellHidden,
          header: cellHeader,
          sheetName, addr, isHeaderRow: isHeaderRow && !kvTargets.has(key),
        });
        const excluded = kvTargets.has(key) || (r > headR && hidden[c] && hidden[c] !== "NAME") ||
          (r > headR && hidden[c] === "NAME" && isNameLike(asText));
        if (!isHeaderRow && !excluded && /\p{L}{3,}/u.test(asText)) rowBits.push(asText);
        if (cell.c) delete cell.c; // cell comments can hold names
        if (cell.l) delete cell.l; // hyperlinks can hold mailto: addresses
      }
      if (rowBits.length) learnTexts.push(rowBits.join(" | "));
    }
    const hiddenCols = Object.entries(hidden).filter(([, t]) => t);
    if (hiddenCols.length)
      warnings.push(
        `Sheet "${sheetName}": hid whole columns ` +
          hiddenCols.map(([c]) => textAt(headR, +c)).join(", ") +
          ".",
      );
  }

  await learnWithBudget(redactor, learnTexts, status, warnings);

  for (const { cell, asText, hidden, header, sheetName, addr } of plan) {
    const loc = `${sheetName}!${addr}`;
    let replacement = null;
    if (hidden) {
      if (asText) {
        const base = redactor.report.length;
        replacement = redactor.hideAs(hidden, asText, header);
        tagReport(redactor, base, loc);
      } else {
        replacement = null;
      }
    } else {
      const base = redactor.report.length;
      const redacted = redactor.apply(asText);
      tagReport(redactor, base, loc);
      if (redacted !== asText) replacement = redacted;
    }
    if (replacement !== null) {
      cell.t = "s";
      cell.v = replacement;
      cell.w = replacement;
      delete cell.f;
      delete cell.z;
    }
  }
  wb.Props = {};
  // Extra sheet carrying the LLM notice as real text.
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[LLM_NOTICE]]), "Redaction notice");
  const out = XLSX.write(wb, { bookType: "xlsx", type: "array", cellStyles: true });
  warnings.push("Cell colours and fonts may be simplified in the redacted workbook.");
  return {
    blob: new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
    name: outName(file.name, "xlsx"),
    warnings,
    report: redactor.report.slice(),
  };
}

// ------------------------------------------------------------------- pictures
// Standalone JPG/PNG/WebP: OCR the pixels, run the SAME redactor over the
// OCR text, burn black boxes into the pixels. All pixel budgets live here so
// every handler (images, PDF pages, docx pictures) caps memory the same way.
const PX_CAP = 16_000_000;
const IMAGE_MIME = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/png" };
const IMAGE_OUT_EXT = { jpg: "jpg", jpeg: "jpeg", png: "png", webp: "png" }; // webp is saved as png

const canvasBlob = (canvas, mime, quality) =>
  new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("Could not encode the redacted picture."))), mime, quality));

function drawBitmap(bitmap, scale) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function redactImage(file, redactor, status, ext) {
  const warnings = [];
  const bitmap = await createImageBitmap(file);
  try {
    // WHY two canvases: tiny phone photos need upscaling for the OCR engine
    // to read them, but the saved file stays at (capped) original size.
    const outScale = Math.min(1, Math.sqrt(PX_CAP / (bitmap.width * bitmap.height)));
    const out = drawBitmap(bitmap, outScale);
    const { canvas: work, k } = cropForOcr(out, { x0: 0, y0: 0, x1: out.width, y1: out.height });
    status("Reading text in the picture…");
    const { text, ranges } = await ocrCanvas(work);
    await learnWithBudget(redactor, [text], status, warnings);
    const spans = redactor.spans(text);
    if (spans.length) {
      const base = redactor.report.length;
      redactor.count(spans, text);
      tagReport(redactor, base, "image (OCR)");
      blacken(out.getContext("2d"), boxesForSpans(spans, ranges).map((b) => scaleBox(b, 1 / k)));
    }
    const mime = IMAGE_MIME[ext] || "image/png";
    const blob = await canvasBlob(out, mime, 0.92);
    return { blob, name: outName(file.name, IMAGE_OUT_EXT[ext] || "png"), warnings, report: redactor.report.slice() };
  } finally {
    bitmap.close();
  }
}

// -------------------------------------------------------------------- docx
const W_PARTS = /^word\/(document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml$/;

function closest(el, tag) {
  for (let n = el.parentNode; n; n = n.parentNode) if (n.nodeName === tag) return n;
  return null;
}

/** Write redacted text back into the paragraph's <w:t> nodes, keeping each run's formatting. */
function applySpansToRuns(nodes, spans) {
  for (const node of nodes) {
    const text = node.text;
    let out = "";
    let pos = node.start;
    for (const sp of spans) {
      if (sp.end <= node.start || sp.start >= node.end) continue;
      const a = Math.max(sp.start, node.start);
      const b = Math.min(sp.end, node.end);
      out += text.slice(pos - node.start, a - node.start);
      if (sp.start >= node.start) out += labelFor(sp.type);
      pos = b;
    }
    out += text.slice(pos - node.start);
    node.el.textContent = out;
    node.el.setAttributeNS("http://www.w3.org/XML/1998/namespace", "xml:space", "preserve");
  }
}

function partLabel(name) {
  if (/header\d*\.xml$/.test(name)) return "header";
  if (/footer\d*\.xml$/.test(name)) return "footer";
  if (/footnotes\.xml$/.test(name)) return "footnote";
  if (/endnotes\.xml$/.test(name)) return "endnote";
  if (/comments\.xml$/.test(name)) return "comment";
  return "body";
}

function siblingIndex(el, tag) {
  let n = 0;
  for (let s = el.parentNode?.firstChild; s; s = s.nextSibling) {
    if (s.nodeType === 1 && s.nodeName === tag) {
      n++;
      if (s === el) return n;
    }
  }
  return n || 1;
}

async function redactDocx(file, redactor, status, opts = {}) {
  if (opts.password) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (opts.onlyUnlock) {
      const zip = unlockOffice(bytes, opts.password);
      return {
        blob: new Blob([zip], { type: OFFICE_MIME.docx }),
        name: file.name,
        warnings: ["Password removed. The file is otherwise unchanged.", "Report is empty: only the password was removed, nothing was hidden."],
        report: [],
      };
    }
    file = unlockedFile(file, bytes, opts.password);
  }
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const warnings = [];
  const parser = new DOMParser();
  const docs = [];
  for (const name of Object.keys(zip.files)) {
    if (!W_PARTS.test(name)) continue;
    docs.push({ name, doc: parser.parseFromString(await zip.file(name).async("string"), "application/xml") });
  }

  const paragraphs = [];
  const paraLocByEl = new Map();
  for (const { name, doc } of docs) {
    const part = partLabel(name);
    const byPara = new Map();
    for (const t of doc.getElementsByTagName("w:t")) {
      const p = closest(t, "w:p");
      if (!p) continue;
      if (!byPara.has(p)) byPara.set(p, []);
      byPara.get(p).push(t);
    }
    // Table numbering within this part, in document order.
    const tblIndex = new Map();
    let tblCount = 0;
    for (const tbl of doc.getElementsByTagName("w:tbl")) {
      tblCount++;
      tblIndex.set(tbl, tblCount);
    }
    let paraNo = 0;
    for (const [pEl, els] of byPara.entries()) {
      paraNo++;
      // WHY <w:br/> counts as "\n": without a separator "a@b.com<w:br/>Next"
      // joins into one string and the EMAIL rule swallows the next line's
      // first word. The break element itself is left in place; only the
      // <w:t> text is rewritten, so write-back stays run-accurate.
      let cursor = 0;
      let text = "";
      const nodes = [];
      for (const el of pEl.getElementsByTagName("*")) {
        if (el.nodeName === "w:br") { text += "\n"; cursor += 1; }
        else if (el.nodeName === "w:t") {
          const t = el.textContent;
          nodes.push({ el, text: t, start: cursor, end: cursor + t.length });
          text += t;
          cursor += t.length;
        }
      }
      const tbl = closest(pEl, "w:tbl");
      let location;
      if (tbl) {
        const tr = closest(pEl, "w:tr");
        const tc = closest(pEl, "w:tc");
        location = `${part}, table ${tblIndex.get(tbl) || 1}, row ${tr ? siblingIndex(tr, "w:tr") : 1}, cell ${tc ? siblingIndex(tc, "w:tc") : 1}`;
      } else {
        location = `${part}, paragraph ${paraNo}`;
      }
      paraLocByEl.set(pEl, location);
      paragraphs.push({ nodes, text, location, pEl, part });
    }
  }

  // Pictures (word/media/*): OCR each one now so its text joins the learn
  // pass with the rest of the file, then burn boxes into the pixels after.
  const PIC_RE = /^word\/media\/[^/]+\.(png|jpe?g|webp)$/i;
  const PIC_MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };
  const picNames = Object.keys(zip.files).filter((n) => PIC_RE.test(n));
  const pictures = [];
  let skippedPics = 0;
  for (let n = 0; n < picNames.length; n++) {
    const name = picNames[n];
    try {
      const bytes = await zip.file(name).async("uint8array");
      const bitmap = await createImageBitmap(new Blob([bytes]));
      try {
        const scale = Math.min(1, Math.sqrt(PX_CAP / (bitmap.width * bitmap.height)));
        const base = drawBitmap(bitmap, scale);
        const { canvas: work, k } = cropForOcr(base, { x0: 0, y0: 0, x1: base.width, y1: base.height });
        status(`Reading text in pictures… ${n + 1} of ${picNames.length}`);
        const { text, ranges } = await ocrCanvas(work);
        const ext = (name.split(".").pop() || "png").toLowerCase();
        pictures.push({
          name,
          text,
          ranges: ranges.map((rg) => ({ start: rg.start, end: rg.end, bbox: scaleBox(rg.bbox, 1 / k) })),
          canvas: base,
          mime: PIC_MIME[ext] || "image/png",
        });
      } finally {
        bitmap.close();
      }
    } catch {
      skippedPics++; // corrupt/unreadable picture: leave its bytes untouched
    }
  }

  await learnWithBudget(redactor, [...paragraphs.map((p) => p.text), ...pictures.map((p) => p.text)], status, warnings);

  for (const p of paragraphs) {
    const spans = redactor.spans(p.text);
    if (!spans.length) continue;
    // WHY one count() per paragraph (not per run): a name split across runs
    // ("Priya Na"+"ir") is a single span with the full quote.
    const base = redactor.report.length;
    redactor.count(spans, p.text);
    tagReport(redactor, base, p.location);
    applySpansToRuns(p.nodes, spans);
  }
  // Burn one black box per hit into each picture's pixels, then write the
  // picture back into the zip under the same name (same format).
  for (let n = 0; n < pictures.length; n++) {
    const pic = pictures[n];
    if (!pic.text) continue;
    const spans = redactor.spans(pic.text);
    if (!spans.length) continue;
    const base = redactor.report.length;
      redactor.count(spans, pic.text);
      tagReport(redactor, base, `picture ${n + 1} (OCR)`);
    blacken(pic.canvas.getContext("2d"), boxesForSpans(spans, pic.ranges));
  }
  for (const pic of pictures) {
    const blob = await canvasBlob(pic.canvas, pic.mime, 0.92);
    zip.file(pic.name, new Uint8Array(await blob.arrayBuffer()));
  }
  for (const { name, doc } of docs) {
    const part = partLabel(name);
    for (const el of doc.getElementsByTagName("w:instrText")) {
      const base = redactor.report.length;
      const pEl = closest(el, "w:p");
      const loc = pEl && paraLocByEl.get(pEl) ? `${paraLocByEl.get(pEl)}, field` : `${part}, field`;
      el.textContent = redactor.apply(el.textContent);
      tagReport(redactor, base, loc);
    }
    if (name === "word/comments.xml") {
      for (const c of doc.getElementsByTagName("w:comment")) {
        c.setAttribute("w:author", "Redacted");
        c.setAttribute("w:initials", "R");
      }
    }
    zip.file(name, new XMLSerializer().serializeToString(doc));
  }

  // Links such as mailto:/tel: targets, and author metadata.
  for (const name of Object.keys(zip.files).filter((n) => n.endsWith(".rels"))) {
    const xml = await zip.file(name).async("string");
    const doc = parser.parseFromString(xml, "application/xml");
    let changed = false;
    for (const rel of doc.getElementsByTagName("Relationship")) {
      const target = rel.getAttribute("Target") || "";
      if (rel.getAttribute("TargetMode") === "External" && target) {
        const spans = redactor.spans(target);
        if (spans.length) {
          const base = redactor.report.length;
          redactor.count(spans, target);
          tagReport(redactor, base, "hyperlink");
          rel.setAttribute("Target", "#redacted");
          changed = true;
        }
      }
    }
    if (changed) zip.file(name, new XMLSerializer().serializeToString(doc));
  }
  // Closing notice as the last paragraph of the body (before sectPr), as real text.
  {
    const f = zip.file("word/document.xml");
    if (f) {
      const d = parser.parseFromString(await f.async("string"), "application/xml");
      const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
      const body = d.getElementsByTagNameNS(W, "body")[0];
      if (body) {
        const para = d.createElementNS(W, "w:p");
        const run = d.createElementNS(W, "w:r");
        const t = d.createElementNS(W, "w:t");
        t.textContent = LLM_NOTICE;
        run.appendChild(t);
        para.appendChild(run);
        const last = body.lastElementChild;
        if (last && last.localName === "sectPr") body.insertBefore(para, last);
        else body.appendChild(para);
        zip.file("word/document.xml", new XMLSerializer().serializeToString(d));
      }
    }
  }
  const strip = async (path, tags) => {
    const f = zip.file(path);
    if (!f) return;
    let xml = await f.async("string");
    for (const t of tags) xml = xml.replace(new RegExp(`(<${t}[^>]*>)[^<]*(</${t}>)`, "g"), "$1$2");
    zip.file(path, xml);
  };
  await strip("docProps/core.xml", ["dc:creator", "cp:lastModifiedBy"]);
  await strip("docProps/app.xml", ["Company", "Manager"]);

  if (pictures.length) warnings.push(`Checked ${pictures.length} picture(s) for hidden text.`);
  if (skippedPics) warnings.push(`Skipped ${skippedPics} picture(s) that could not be read.`);
  warnings.push("Word files don't store page numbers, so locations below are paragraphs, tables, headers, footers, comments or footnotes — not pages.");
  const blob = await zip.generateAsync({
    type: "blob",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    compression: "DEFLATE",
  });
  return { blob, name: outName(file.name, "docx"), warnings, report: redactor.report.slice() };
}

// --------------------------------------------------------------------- pdf
// Redacted PDFs are rebuilt from page pictures with solid black boxes burned
// over each hit. The original text layer is dropped, so hidden text cannot be
// copied back out from under the boxes.
let pdfjs = null;
async function loadPdfjs() {
  if (!pdfjs) {
    pdfjs = await import("../vendor/pdfjs/pdf.min.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdfjs/pdf.worker.min.mjs", import.meta.url).href;
  }
  return pdfjs;
}

function pageText(content, viewport, Util) {
  const items = content.items.filter((it) => it.str !== undefined);
  let text = "";
  const entries = [];
  let prev = null;
  for (const item of items) {
    const tr = Util.transform(viewport.transform, item.transform);
    const fontPx = Math.hypot(tr[2], tr[3]) || 1;
    const widthPx = item.width * viewport.scale;
    if (prev) {
      const sameLine = Math.abs(tr[5] - prev.y) < fontPx * 0.5;
      if (!sameLine || prev.hasEOL) text += "\n";
      else if (tr[4] - prev.xEnd > fontPx * 0.15 && !/\s$/.test(prev.str) && !/^\s/.test(item.str)) text += " ";
    }
    const start = text.length;
    text += item.str;
    entries.push({ item, tr, start, end: text.length, family: content.styles?.[item.fontName]?.fontFamily || "sans-serif" });
    prev = { y: tr[5], xEnd: tr[4] + widthPx, hasEOL: item.hasEOL, str: item.str };
  }
  return { text, entries };
}

async function redactPdf(file, redactor, status, opts = {}) {
  const lib = await loadPdfjs();
  const warnings = [];
  let src;
  try {
    src = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), password: opts.password || "", isEvalSupported: false }).promise;
  } catch (err) {
    // pdf.js rejects with PasswordException both when no password was given
    // (needs the unlock UI) and when the given one is wrong (retry message).
    if (err?.name === "PasswordException") throw opts.password ? new WrongPasswordError() : new NeedsPasswordError();
    throw err;
  }
  const pages = [];
  for (let i = 1; i <= src.numPages; i++) {
    const page = await src.getPage(i);
    const content = await page.getTextContent();
    const unit = page.getViewport({ scale: 1 });
    const { text, entries } = pageText(content, unit, lib.Util);
    pages.push({ page, text, entries });
  }
  // "Only remove the password": return the pages as pictures, with no black
  // boxes. The password is gone but so is selectable text; say so plainly.
  // (A scanned PDF is still a faithful copy in this mode, so it is returned.)
  const onlyUnlock = !!opts.onlyUnlock;

  // --- OCR pass (skipped for onlyUnlock: pages are copied as pictures there).
  // A page with (almost) no text layer is a scan: OCR the whole canvas.
  // Other pages contribute crops of their embedded pictures (e.g. a passport
  // scan pasted into a text page). Rendering + OCR happen BEFORE the learn
  // pass so names the model finds in OCR text also hide in the text layer
  // and IDs learned from the text layer also hide in the OCR text.
  const ocrByPage = pages.map(() => null);
  const ocrScales = pages.map(() => 0);
  let ocrPages = 0;
  const cappedPages = [];
  const nonWs = (t) => t.replace(/\s/g, "").length;
  if (!onlyUnlock) {
    const jobs = [];
    for (let i = 0; i < pages.length; i++) {
      const unit = pages[i].page.getViewport({ scale: 1 });
      // ~300dpi equivalent on a letter page, capped like the normal path so
      // a huge page cannot blow up memory (OCR accuracy drops badly below).
      const scale = Math.min(4, Math.sqrt(PX_CAP / (unit.width * unit.height)));
      ocrScales[i] = scale;
      if (nonWs(pages[i].text) < 20) {
        jobs.push({ i, rect: null });
      } else {
        const viewport = pages[i].page.getViewport({ scale });
        const opList = await pages[i].page.getOperatorList();
        const all = embeddedImageRects(opList, viewport, lib.OPS, lib.Util).filter(
          (r) => r.x1 - r.x0 >= 120 && r.y1 - r.y0 >= 40, // logos/icons are too small for text
        );
        if (all.length > 8) cappedPages.push(i + 1); // catalogues: OCR the largest few
        for (const rect of all.slice(0, 8)) jobs.push({ i, rect });
      }
    }
    if (jobs.length) {
      const canvases = new Map();
      const renderFor = async (i) => {
        if (!canvases.has(i)) {
          const viewport = pages[i].page.getViewport({ scale: ocrScales[i] });
          const canvas = document.createElement("canvas");
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          const ctx = canvas.getContext("2d");
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          await pages[i].page.render({ canvasContext: ctx, viewport }).promise;
          canvases.set(i, canvas);
        }
        return canvases.get(i);
      };
      const parts = pages.map(() => []);
      let done = 0;
      for (const job of jobs) {
        done++;
        status(`Reading text in pictures… ${done} of ${jobs.length}`);
        const canvas = await renderFor(job.i);
        if (!job.rect) {
          const r = await ocrCanvas(canvas);
          if (r.text) parts[job.i].push(r);
        } else {
          const { canvas: crop, x0, y0, k } = cropForOcr(canvas, job.rect);
          const r = await ocrCanvas(crop);
          if (r.text)
            parts[job.i].push({
              text: r.text,
              ranges: r.ranges.map((rg) => ({
                start: rg.start,
                end: rg.end,
                bbox: {
                  x0: x0 + rg.bbox.x0 / k,
                  y0: y0 + rg.bbox.y0 / k,
                  x1: x0 + rg.bbox.x1 / k,
                  y1: y0 + rg.bbox.y1 / k,
                },
              })),
            });
        }
      }
      canvases.clear();
      for (let i = 0; i < pages.length; i++) {
        if (!parts[i].length) continue;
        // WHY re-offset here: each crop's ranges start at 0, but spans() runs
        // on the joined page text, so ranges must carry joined offsets.
        let text = "";
        const ranges = [];
        for (const part of parts[i]) {
          if (text) text += "\n";
          const off = text.length;
          text += part.text;
          for (const rg of part.ranges) ranges.push({ start: rg.start + off, end: rg.end + off, bbox: rg.bbox });
        }
        ocrByPage[i] = { text, ranges };
        ocrPages++;
      }
    }
  }
  if (ocrPages) warnings.push(`Checked pictures on ${ocrPages} of ${pages.length} page(s) with offline OCR.`);
  if (cappedPages.length)
    warnings.push(`Page(s) ${cappedPages.join(", ")}: only the 8 largest pictures were checked.`);

  if (onlyUnlock) warnings.push("Password removed. Pages are saved as pictures, so the text in this PDF can no longer be selected.");
  else
    await learnWithBudget(
      redactor,
      [...pages.map((p) => p.text), ...ocrByPage.map((o) => o?.text || "")],
      (t) => status(t.replace(/Looking for names and addresses… (\d+) of (\d+)/, "Scanning $1 of $2 pages...")),
      warnings,
    );

  const measure = document.createElement("canvas").getContext("2d");
  const out = await PDFLib.PDFDocument.create();
  for (let i = 0; i < pages.length; i++) {
    status(onlyUnlock ? `Copied ${i} of ${pages.length} pages...` : `Removed PIIs from ${i} of ${pages.length} pages...`);
    const { page, text } = pages[i];
    const unit = page.getViewport({ scale: 1 });
    const ocr = ocrByPage[i];
    // OCR'd pages render at the OCR scale so the word boxes line up exactly.
    const scale = ocr ? ocrScales[i] : Math.min(2, Math.sqrt(PX_CAP / (unit.width * unit.height)));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;

    // Positions must come from the SAME viewport the canvas is drawn with.
    // WHY record here (not in the learn pass above): the page text is built
    // twice, and counting both would list everything twice.
    if (!onlyUnlock) {
      const scaled = pageText(await page.getTextContent(), viewport, lib.Util);
      const spans = redactor.spans(scaled.text);
      const base = redactor.report.length;
      redactor.count(spans, scaled.text);
      const pageNo = String(i + 1);
      for (let k = base; k < redactor.report.length; k++) {
        const e = redactor.report[k];
        e.page = pageNo;
        e.location = `page ${pageNo}, line ${e.start != null ? lineOf(scaled.text, e.start) : 1}`;
      }
      ctx.fillStyle = "#000";
      for (const sp of spans) {
      for (const e of scaled.entries) {
        const len = e.end - e.start;
        if (!len || sp.end <= e.start || sp.start >= e.end) continue;
        let a = Math.max(sp.start, e.start) - e.start;
        let b = Math.min(sp.end, e.end) - e.start;
        const str = e.item.str;
        // Widen to whole words: glyph positions are measured, not exact, so
        // the box must not end half-way through a character.
        while (a > 0 && !/\s/.test(str[a - 1])) a--;
        while (b < str.length && !/\s/.test(str[b])) b++;
        const em = Math.hypot(e.item.transform[0], e.item.transform[1]) || 1;
        const wEm = e.item.width / em;
        // Real proportional widths, measured in a stand-in for the PDF's font.
        measure.font = `100px ${e.family}`;
        const whole = measure.measureText(str).width || 1;
        const pad = 0.35 * (wEm / len);
        const u0 = Math.max(0, (measure.measureText(str.slice(0, a)).width / whole) * wEm - pad);
        const u1 = Math.min(wEm, (measure.measureText(str.slice(0, b)).width / whole) * wEm + pad);
        ctx.save();
        ctx.transform(...e.tr);
        ctx.fillRect(u0, -0.28, u1 - u0, 1.2);
        ctx.restore();
      }
      }
    }
    if (!onlyUnlock && ocr?.text) {
      // Boxes over the OCR'd words (scan pages and embedded pictures),
      // tagged so the report says where the text came from.
      const ocrSpans = redactor.spans(ocr.text);
      const base = redactor.report.length;
      redactor.count(ocrSpans, ocr.text);
      const pageNo = String(i + 1);
      for (let k = base; k < redactor.report.length; k++) {
        const e = redactor.report[k];
        e.page = pageNo;
        e.location = `page ${pageNo}, picture (OCR)`;
      }
      blacken(ctx, boxesForSpans(ocrSpans, ocr.ranges));
    }
    const jpg = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.85));
    const img = await out.embedJpg(new Uint8Array(await jpg.arrayBuffer()));
    const pdfPage = out.addPage([unit.width, unit.height]);
    pdfPage.drawImage(img, { x: 0, y: 0, width: unit.width, height: unit.height });
    page.cleanup();
  }
  // Closing page with the notice as real, selectable text. Skipped when the
  // file is only being unlocked, not redacted.
  if (!onlyUnlock && pages.length) {
    const last = pages[pages.length - 1].page.getViewport({ scale: 1 });
    const font = await out.embedFont(PDFLib.StandardFonts.Helvetica);
    const notePage = out.addPage([last.width, last.height]);
    const size = 11, maxW = last.width - 100;
    let line = "", y = last.height - 60;
    for (const word of LLM_NOTICE.split(" ")) {
      const next = line ? line + " " + word : word;
      if (font.widthOfTextAtSize(next, size) > maxW) {
        notePage.drawText(line, { x: 50, y, size, font });
        y -= size * 1.5;
        line = word;
      } else line = next;
    }
    if (line) notePage.drawText(line, { x: 50, y, size, font });
  }
  status(onlyUnlock ? `Copied ${pages.length} of ${pages.length} pages...` : `Removed PIIs from ${pages.length} of ${pages.length} pages...`);
  const blank = pages.filter((p, i) => !nonWs(p.text) && !nonWs(ocrByPage[i]?.text || "")).length;
  if (blank)
    warnings.push(`${blank} page(s) have no readable text (pictures only). They were copied as-is, so please check them by eye.`);
  if (!onlyUnlock) warnings.push("Pages are saved as pictures with black boxes, so the text in this PDF can no longer be selected.");
  const name = onlyUnlock ? file.name : outName(file.name, "pdf");
  if (onlyUnlock) {
    warnings.push("Report is empty: only the password was removed, nothing was hidden.");
  }
  return { blob: new Blob([await out.save()], { type: "application/pdf" }), name, warnings, report: onlyUnlock ? [] : redactor.report.slice() };
}

// ------------------------------------------------------------------- entry
class FriendlyError extends Error {}
// Internal only: the file needs a password before anything can be done.
// app.js turns this into the inline password box, never an error message.
export class NeedsPasswordError extends Error {}

function friendly(err, ext) {
  if (err instanceof FriendlyError) return err;
  if (err instanceof NeedsPasswordError) return err;
  if (err instanceof WrongPasswordError) {
    // WHY a code, not message matching: app.js must tell "wrong password,
    // try again" apart from fatal errors without parsing English sentences.
    const out = new FriendlyError("That password didn't work. Check it and try again — caps lock catches everyone out.");
    out.code = "wrong-password";
    return out;
  }
  if (err instanceof UnsupportedEncryptionError)
    return new FriendlyError(
      "This file uses an older kind of Office password protection that this tool can't open. " +
        "Open it in Word or Excel and re-save it without a password, then drop it in again.",
    );
  const text = `${err?.name || ""} ${err?.message || ""}`;
  if (/password/i.test(text))
    return new FriendlyError("This file is protected with a password. Remove the password first, then try again.");
  const kind = { pdf: "PDF", docx: "Word", xlsx: "Excel", xls: "Excel" }[ext];
  if (kind && /zip|corrupt|invalid|unexpected|not a|signature|central directory|format|parse|header|xref|stream/i.test(text))
    return new FriendlyError(`This doesn't look like a valid ${kind} file, or it is damaged. Try opening and re-saving it, then drop it in again.`);
  return err;
}
export async function redactFile(file, redactor, status, opts = {}) {
  redactor.resetFile();
  const ext = extOf(file.name);
  try {
    switch (ext) {
      case "txt":
      case "md":
        return await redactText(file, redactor, status, ext);
      case "csv":
        return await redactCsv(file, redactor, status);
      case "xlsx":
      case "xls":
        return await redactXlsx(file, redactor, status, opts);
      case "docx":
        return await redactDocx(file, redactor, status, opts);
      case "pdf":
        return await redactPdf(file, redactor, status, opts);
      case "jpg":
      case "jpeg":
      case "png":
      case "webp":
        return await redactImage(file, redactor, status, ext);
      default:
        throw new FriendlyError(`.${ext} files are not supported. Try PDF, Word (.docx), Excel, CSV, text, Markdown or images (JPG, PNG, WebP).`);
    }
  } catch (err) {
    throw friendly(err, ext);
  }
}
