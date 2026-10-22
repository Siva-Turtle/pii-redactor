// Offline OCR for text that sits inside pictures (tesseract.js v5, vendored).
//
// WHY a separate module: handlers.js is already big; all worker setup, OCR
// calls and the OCR-text -> pixel-box mapping live here. Everything runs
// from vendored files under ../vendor/tesseract/ (no network), and the
// worker is created with workerBlobURL:false because blob: scripts are
// banned by the page's Content-Security-Policy.

const vendorUrl = (file) => new URL(`../vendor/tesseract/${file}`, import.meta.url).href;

let workerPromise = null;

function loadOptions(onStatus) {
  return {
    workerPath: vendorUrl("worker.min.js"),
    // A directory: the worker picks the SIMD/LSTM core build itself.
    corePath: vendorUrl(""),
    langPath: vendorUrl(""),
    gzip: false, // we vendor eng.traineddata uncompressed
    workerBlobURL: false, // blob: worker scripts violate our CSP
    logger: (m) => onStatus?.(m),
  };
}

// Lazily create one shared worker (OCR setup costs seconds) and reuse it
// across files. The promise resets on failure so a later file can retry.
async function getWorker(onStatus) {
  if (!workerPromise) {
    workerPromise = (async () => {
      const T = globalThis.Tesseract;
      if (!T?.createWorker) throw new Error("OCR engine failed to load.");
      const worker = await T.createWorker("eng", 1, loadOptions(onStatus));
      // PSM.AUTO (fully automatic page segmentation) suits scanned documents.
      if (T.PSM?.AUTO) await worker.setParameters({ tessedit_pageseg_mode: T.PSM.AUTO });
      return worker;
    })();
    workerPromise.catch(() => {
      workerPromise = null;
    });
  }
  return workerPromise;
}

export async function terminateOcr() {
  if (!workerPromise) return;
  try {
    const worker = await workerPromise;
    await worker.terminate();
  } catch {
    /* terminating is best-effort */
  }
  workerPromise = null;
}

if (typeof window !== "undefined") {
  // WHY pagehide (not unload): the worker holds MBs of wasm; releasing it
  // when the page goes away keeps nothing alive longer than the tab.
  window.addEventListener("pagehide", () => {
    terminateOcr();
  });
}

/**
 * Run OCR over a canvas (or anything drawable: bitmap, blob, image). Returns
 * the words in reading order plus the joined text and each word's char
 * range, ready for redactor.spans().
 */
export async function ocrCanvas(image, { onStatus } = {}) {
  const worker = await getWorker(onStatus);
  const canvas = await toCanvas(image);
  const { data } = await worker.recognize(canvas);
  const words = [];
  for (const w of data.words || []) {
    const text = String(w.text ?? "").trim();
    if (!text || !w.bbox) continue;
    words.push({
      text,
      bbox: { x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 },
    });
  }
  const page = buildOcrPage(words);
  return { words, text: page.text, ranges: page.ranges };
}

// WHY normalise here: tesseract's loader takes canvases and blobs but not
// ImageBitmaps, and callers should not have to remember that.
async function toCanvas(image) {
  if (typeof HTMLCanvasElement !== "undefined" && image instanceof HTMLCanvasElement) return image;
  if (typeof OffscreenCanvas !== "undefined" && image instanceof OffscreenCanvas) return image;
  const bmp = image instanceof ImageBitmap ? image : await createImageBitmap(image);
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  canvas.getContext("2d").drawImage(bmp, 0, 0);
  if (!(image instanceof ImageBitmap)) bmp.close();
  return canvas;
}

const cx = (w) => (w.bbox.x0 + w.bbox.x1) / 2;
const cy = (w) => (w.bbox.y0 + w.bbox.y1) / 2;
const x0 = (w) => w.bbox.x0;

/**
 * Build one OCR page text from flat words in reading order (lines joined
 * with "\n", words with " "), keeping every word's char range and pixel
 * bbox. Words that vertically overlap belong to one line; lines run top to
 * bottom, words left to right.
 */
export function buildOcrPage(words) {
  const ws = (words || []).filter((w) => w.text && String(w.text).trim() && w.bbox);
  const sorted = [...ws].sort((a, b) => cy(a) - cy(b) || x0(a) - x0(b));
  const lines = [];
  for (const w of sorted) {
    const last = lines.length ? lines[lines.length - 1] : null;
    if (last) {
      const top = Math.min(...last.map((m) => m.bbox.y0));
      const bottom = Math.max(...last.map((m) => m.bbox.y1));
      const h = Math.min(w.bbox.y1 - w.bbox.y0, bottom - top);
      const overlap = Math.min(w.bbox.y1, bottom) - Math.max(w.bbox.y0, top);
      if (h > 0 && overlap > 0.3 * h) {
        last.push(w);
        continue;
      }
    }
    lines.push([w]);
  }
  for (const line of lines) line.sort((a, b) => x0(a) - x0(b));
  let text = "";
  const ranges = [];
  lines.forEach((line, li) => {
    if (li > 0) text += "\n";
    line.forEach((w, wi) => {
      if (wi > 0) text += " ";
      const start = text.length;
      text += w.text;
      ranges.push({ start, end: text.length, bbox: { ...w.bbox } });
    });
  });
  return { text, ranges };
}

/**
 * Map redactor spans onto pixel boxes: for every span, the union of the
 * bboxes of all words it touches (whole words, like the PDF text-layer path
 * which widens to word edges), plus a small padding so glyph edges hide.
 */
export function boxesForSpans(spans, ranges, pad = 2) {
  const boxes = [];
  for (const sp of spans || []) {
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    let hit = false;
    for (const r of ranges || []) {
      if (r.end <= sp.start || r.start >= sp.end) continue;
      hit = true;
      bx0 = Math.min(bx0, r.bbox.x0);
      by0 = Math.min(by0, r.bbox.y0);
      bx1 = Math.max(bx1, r.bbox.x1);
      by1 = Math.max(by1, r.bbox.y1);
    }
    if (hit) {
      boxes.push({
        x0: Math.max(0, bx0 - pad),
        y0: Math.max(0, by0 - pad),
        x1: bx1 + pad,
        y1: by1 + pad,
      });
    }
  }
  return boxes;
}

/** Fill every box solid black, in place on a canvas 2d context. */
export function blacken(ctx, boxes) {
  ctx.save();
  ctx.fillStyle = "#000";
  for (const b of boxes) ctx.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
  ctx.restore();
}

/** Scale a pixel box by f (maps OCR-work coords back onto another canvas). */
export function scaleBox(b, f) {
  return { x0: b.x0 * f, y0: b.y0 * f, x1: b.x1 * f, y1: b.y1 * f };
}

const CROP_UPSCALE_PX = 800; // crops smaller than this are doubled for the OCR engine
const CROP_MAX_PX = 4_000_000; // ...but never beyond this many pixels

/**
 * Cut a rectangle out of a canvas for OCR, upscaling tiny crops (a logo-size
 * crop has too few pixels for the OCR engine to read). Returns the crop plus
 * the origin/scale that map crop coords back: page = origin + crop / k.
 */
export function cropForOcr(src, rect) {
  const w = Math.max(1, Math.round(rect.x1 - rect.x0));
  const h = Math.max(1, Math.round(rect.y1 - rect.y0));
  let k = Math.max(w, h) < CROP_UPSCALE_PX ? 2 : 1;
  if (w * k * h * k > CROP_MAX_PX) k = Math.max(1, Math.sqrt(CROP_MAX_PX / (w * h)));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * k));
  canvas.height = Math.max(1, Math.round(h * k));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(src, rect.x0, rect.y0, w, h, 0, 0, canvas.width, canvas.height);
  return { canvas, x0: rect.x0, y0: rect.y0, k };
}

const applyMat = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/**
 * Find every embedded picture's rectangle on a PDF page, in canvas pixels of
 * `viewport`. WHY the operator list: each paintImageXObject lands inside the
 * unit square of the current transform, so tracking the transform stack
 * (save/restore/transform, plus the form matrix that
 * paintFormXObjectBegin carries for pasted-in pages) gives each picture's
 * position without rendering anything. Stencil masks are skipped (1bpp
 * ticks/logos, not photos of text). Returns deduplicated rects, largest
 * first. `OPS`/`Util` come from the caller's pdf.js so this module never
 * imports pdf.js itself.
 */
export function embeddedImageRects(opList, viewport, OPS, Util) {
  const rects = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const { fnArray, argsArray } = opList;
  const concat = (m) => {
    if (Array.isArray(m) && m.length >= 6) ctm = Util.transform(ctm, m.slice(0, 6));
  };
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i] || [];
    if (fn === OPS.save) {
      stack.push(ctm);
    } else if (fn === OPS.restore) {
      if (stack.length) ctm = stack.pop();
    } else if (fn === OPS.transform) {
      concat(Array.isArray(args[0]) ? args[0] : args);
    } else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      concat(args[0]);
    } else if (fn === OPS.paintFormXObjectEnd) {
      if (stack.length) ctm = stack.pop();
    } else if (
      fn === OPS.paintImageXObject ||
      fn === OPS.paintInlineImageXObject ||
      fn === OPS.paintImageXObjectRepeat ||
      fn === OPS.paintInlineImageXObjectGroup
    ) {
      const dev = Util.transform(viewport.transform, ctm);
      const xs = [], ys = [];
      for (const [px, py] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const [dx, dy] = applyMat(dev, px, py);
        xs.push(dx);
        ys.push(dy);
      }
      rects.push({
        x0: Math.min(...xs),
        y0: Math.min(...ys),
        x1: Math.max(...xs),
        y1: Math.max(...ys),
      });
    }
  }
  // Clamp to the canvas, drop empties, dedupe identical draws, largest first.
  const seen = new Set();
  const out = [];
  for (const r of rects) {
    const x0 = Math.max(0, Math.floor(r.x0));
    const y0 = Math.max(0, Math.floor(r.y0));
    const x1 = Math.min(viewport.width, Math.ceil(r.x1));
    const y1 = Math.min(viewport.height, Math.ceil(r.y1));
    if (x1 - x0 < 1 || y1 - y0 < 1) continue;
    const key = `${x0},${y0},${x1},${y1}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ x0, y0, x1, y1 });
  }
  out.sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0));
  return out;
}
