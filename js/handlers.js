// One handler per file type. Each takes the file's bytes plus a Redactor and
// returns { blob, name, warnings }. Everything runs in the browser; nothing is
// uploaded. Globals JSZip, XLSX and PDFLib come from the <script> tags in
// index.html; pdf.js is imported as a module.

import { parseCsv, stringifyCsv, detectDelimiter } from "./csv.js";
import { labelFor } from "./patterns.js";

const AI_CHUNK_BUDGET = 600;

export const SUPPORTED = ["pdf", "xlsx", "xls", "csv", "txt", "md", "docx"];

export const extOf = (name) => (name.split(".").pop() || "").toLowerCase();

function outName(name, ext) {
  const base = name.replace(/\.[^.]+$/, "");
  return `${base}.redacted.${ext}`;
}

// Spreadsheet columns whose header says what they hold. The whole column is
// hidden — cheaper and safer than asking the AI about every cell.
export function headerType(header) {
  const h = String(header ?? "").trim();
  if (!h) return null;
  if (/e-?mail/i.test(h)) return "EMAIL";
  if (/phone|mobile|whats\s?app|contact\s*(no|num)|\btel\b/i.test(h)) return "PHONE";
  if (/\bdob\b|birth/i.test(h)) return "DATE";
  if (/address|street|locality|pin\s*code|postal|\bzip/i.test(h)) return "ADDRESS";
  if (/\b(pan|aadhaa?r|ssn|passport|ifsc|gstin)\b|(account|a\/c|card)\s*(no|num)/i.test(h)) return "ID";
  if (
    /name/i.test(h) &&
    !/file|sheet|company|bank|scheme|fund|product|plan|branch|city|state|country|nick|user|business|organi[sz]ation|entity|employer/i.test(h)
  )
    return "NAME";
  return null;
}

async function learnWithBudget(redactor, texts, status, warnings) {
  if (!redactor.detector) return;
  const r = await redactor.learn(texts, {
    maxChunks: AI_CHUNK_BUDGET,
    onProgress: (i, n) => status(`Looking for names and addresses… ${i} of ${n}`),
  });
  if (r.truncated) {
    warnings.push(
      `This file is large, so the AI looked at the first ${r.scanned} of ${r.total} sections. ` +
        `Emails, phone numbers, ID numbers and dates were checked everywhere. Please skim the result for stray names.`,
    );
  }
}

// ---------------------------------------------------------------- text / md
async function redactText(file, redactor, status, ext) {
  const text = new TextDecoder("utf-8").decode(await file.arrayBuffer());
  const warnings = [];
  await learnWithBudget(redactor, [text], status, warnings);
  const out = redactor.apply(text);
  return { blob: new Blob([out], { type: "text/plain" }), name: outName(file.name, ext), warnings };
}

// --------------------------------------------------------------------- csv
async function redactCsv(file, redactor, status) {
  let text = new TextDecoder("utf-8").decode(await file.arrayBuffer());
  const bom = text.charCodeAt(0) === 0xfeff ? "﻿" : "";
  text = text.replace(/^﻿/, "");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const delimiter = detectDelimiter(text);
  const rows = parseCsv(text, delimiter);
  const warnings = [];
  const hidden = (rows[0] || []).map(headerType);

  const rowText = (row) =>
    row.filter((cell, c) => !hidden[c] && /\p{L}{3,}/u.test(cell)).join(" | ");
  await learnWithBudget(redactor, rows.slice(1).map(rowText), status, warnings);

  const out = rows.map((row, r) =>
    r === 0
      ? row
      : row.map((cell, c) => (hidden[c] ? redactor.hideAs(hidden[c], cell) : redactor.apply(cell))),
  );
  const hiddenCols = (rows[0] || []).filter((_, c) => hidden[c]);
  if (hiddenCols.length) warnings.push(`Hid whole columns: ${hiddenCols.join(", ")}.`);
  return {
    blob: new Blob([bom + stringifyCsv(out, delimiter, eol)], { type: "text/csv" }),
    name: outName(file.name, "csv"),
    warnings,
  };
}

// -------------------------------------------------------------------- xlsx
async function redactXlsx(file, redactor, status) {
  const wb = XLSX.read(await file.arrayBuffer(), { type: "array", cellStyles: true });
  const warnings = [];
  const plan = [];
  const learnTexts = [];

  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    if (!sheet || !sheet["!ref"]) continue;
    const range = XLSX.utils.decode_range(sheet["!ref"]);
    const hidden = {};
    for (let c = range.s.c; c <= range.e.c; c++) {
      const head = sheet[XLSX.utils.encode_cell({ r: range.s.r, c })];
      hidden[c] = head ? headerType(head.w ?? head.v) : null;
    }
    for (let r = range.s.r; r <= range.e.r; r++) {
      const rowBits = [];
      for (let c = range.s.c; c <= range.e.c; c++) {
        const addr = XLSX.utils.encode_cell({ r, c });
        const cell = sheet[addr];
        if (!cell) continue;
        const asText = String(cell.w ?? cell.v ?? "");
        const isHeaderRow = r === range.s.r;
        plan.push({ cell, asText, hidden: isHeaderRow ? null : hidden[c], isHeaderRow });
        if (!isHeaderRow && !hidden[c] && /\p{L}{3,}/u.test(asText)) rowBits.push(asText);
        if (cell.c) delete cell.c; // cell comments can hold names
        if (cell.l) delete cell.l; // hyperlinks can hold mailto: addresses
      }
      if (rowBits.length) learnTexts.push(rowBits.join(" | "));
    }
    const hiddenCols = Object.entries(hidden).filter(([, t]) => t);
    if (hiddenCols.length)
      warnings.push(
        `Sheet "${sheetName}": hid whole columns ` +
          hiddenCols.map(([c]) => sheet[XLSX.utils.encode_cell({ r: range.s.r, c: +c })]?.w).join(", ") +
          ".",
      );
  }

  await learnWithBudget(redactor, learnTexts, status, warnings);

  for (const { cell, asText, hidden } of plan) {
    let replacement = null;
    if (hidden) {
      replacement = asText ? redactor.hideAs(hidden, asText) : null;
    } else {
      const redacted = redactor.apply(asText);
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
  const out = XLSX.write(wb, { bookType: "xlsx", type: "array", cellStyles: true });
  warnings.push("Cell colours and fonts may be simplified in the redacted workbook.");
  return {
    blob: new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
    name: outName(file.name, "xlsx"),
    warnings,
  };
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

async function redactDocx(file, redactor, status) {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const warnings = [];
  const parser = new DOMParser();
  const docs = [];
  for (const name of Object.keys(zip.files)) {
    if (!W_PARTS.test(name)) continue;
    docs.push({ name, doc: parser.parseFromString(await zip.file(name).async("string"), "application/xml") });
  }

  const paragraphs = [];
  for (const { doc } of docs) {
    const byPara = new Map();
    for (const t of doc.getElementsByTagName("w:t")) {
      const p = closest(t, "w:p");
      if (!p) continue;
      if (!byPara.has(p)) byPara.set(p, []);
      byPara.get(p).push(t);
    }
    for (const els of byPara.values()) {
      let cursor = 0;
      const nodes = els.map((el) => {
        const text = el.textContent;
        const n = { el, text, start: cursor, end: cursor + text.length };
        cursor = n.end;
        return n;
      });
      paragraphs.push({ nodes, text: nodes.map((n) => n.text).join("") });
    }
  }

  await learnWithBudget(redactor, paragraphs.map((p) => p.text), status, warnings);

  for (const p of paragraphs) {
    const spans = redactor.spans(p.text);
    if (!spans.length) continue;
    redactor.count(spans);
    applySpansToRuns(p.nodes, spans);
  }
  for (const { name, doc } of docs) {
    for (const el of doc.getElementsByTagName("w:instrText")) el.textContent = redactor.apply(el.textContent);
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
      if (rel.getAttribute("TargetMode") === "External" && redactor.spans(target).length) {
        redactor.count(redactor.spans(target));
        rel.setAttribute("Target", "#redacted");
        changed = true;
      }
    }
    if (changed) zip.file(name, new XMLSerializer().serializeToString(doc));
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

  if (Object.keys(zip.files).some((n) => n.startsWith("word/media/")))
    warnings.push("This document contains pictures. Text inside pictures is not read or hidden.");
  const blob = await zip.generateAsync({
    type: "blob",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    compression: "DEFLATE",
  });
  return { blob, name: outName(file.name, "docx"), warnings };
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

async function redactPdf(file, redactor, status) {
  const lib = await loadPdfjs();
  const warnings = [];
  const src = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
  const pages = [];
  for (let i = 1; i <= src.numPages; i++) {
    const page = await src.getPage(i);
    const content = await page.getTextContent();
    const unit = page.getViewport({ scale: 1 });
    const { text, entries } = pageText(content, unit, lib.Util);
    pages.push({ page, text, entries });
  }
  const chars = pages.reduce((n, p) => n + p.text.replace(/\s/g, "").length, 0);
  if (chars < 20) {
    throw new Error(
      "This PDF looks like a scan (a picture of a page), so there is no text to find. " +
        "Run it through OCR first, then try again.",
    );
  }
  const blank = pages.filter((p) => p.text.replace(/\s/g, "").length === 0).length;
  if (blank)
    warnings.push(`${blank} page(s) have no readable text (pictures only). They were copied as-is, so please check them by eye.`);

  await learnWithBudget(redactor, pages.map((p) => p.text), status, warnings);

  const measure = document.createElement("canvas").getContext("2d");
  const out = await PDFLib.PDFDocument.create();
  for (let i = 0; i < pages.length; i++) {
    status(`Redacting page ${i + 1} of ${pages.length}…`);
    const { page, text } = pages[i];
    const unit = page.getViewport({ scale: 1 });
    const scale = Math.min(2, Math.sqrt(16_000_000 / (unit.width * unit.height)));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;

    // Positions must come from the SAME viewport the canvas is drawn with.
    const scaled = pageText(await page.getTextContent(), viewport, lib.Util);
    const spans = redactor.spans(scaled.text);
    redactor.count(spans);
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
    const jpg = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.85));
    const img = await out.embedJpg(new Uint8Array(await jpg.arrayBuffer()));
    const pdfPage = out.addPage([unit.width, unit.height]);
    pdfPage.drawImage(img, { x: 0, y: 0, width: unit.width, height: unit.height });
    page.cleanup();
  }
  warnings.push("Pages are saved as pictures with black boxes, so the text in this PDF can no longer be selected.");
  return { blob: new Blob([await out.save()], { type: "application/pdf" }), name: outName(file.name, "pdf"), warnings };
}

// ------------------------------------------------------------------- entry
export async function redactFile(file, redactor, status) {
  redactor.resetFile();
  const ext = extOf(file.name);
  switch (ext) {
    case "txt":
    case "md":
      return redactText(file, redactor, status, ext);
    case "csv":
      return redactCsv(file, redactor, status);
    case "xlsx":
    case "xls":
      return redactXlsx(file, redactor, status);
    case "docx":
      return redactDocx(file, redactor, status);
    case "pdf":
      return redactPdf(file, redactor, status);
    default:
      throw new Error(`.${ext} files are not supported. Try PDF, Word (.docx), Excel, CSV, text or Markdown.`);
  }
}
