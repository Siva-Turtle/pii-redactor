// Pure decision logic for the offline asset cache (sw.js).
//
// WHY a separate module: the same predicate must run inside the service
// worker (to pick fetch events) and inside node test/unit.mjs (to pin the
// behaviour), so it keeps zero browser dependencies.
export const CACHE_NAME = "pii-assets-v1";

// Only the heavy offline blobs are cached: the GLiNER onnx weights + wasm
// under vendor/, and the Tesseract core/lang files under vendor/ (see
// js/ocr.js). models/ covers the tokenizer/config json next to them.
const CACHED_DIRS = ["vendor/", "models/"];

function hasRangeHeader(headers) {
  if (!headers) return false;
  try {
    if (typeof headers.get === "function") return headers.get("range") != null;
  } catch {
    return false;
  }
  if (typeof headers === "object") {
    for (const k of Object.keys(headers)) {
      if (String(k).toLowerCase() === "range" && headers[k] != null) return true;
    }
  }
  return false;
}

// True when `url` is a cacheable offline asset for a worker whose scope is
// `scopeUrl`. Everything else must go straight to the network so app code
// (index.html, js/) is never stale and user documents are never touched
// (they are read via File APIs, never fetched).
export function shouldCache(url, method = "GET", headers = null, scopeUrl = "/") {
  if (String(method || "GET").toUpperCase() !== "GET") return false;
  // WHY bypass Range: js/gliner.js modelMissing() probes the model with HEAD
  // and bytes=0-0; a sliced response must never be stored as the full asset.
  if (hasRangeHeader(headers)) return false;
  let u;
  let scope;
  try {
    u = new URL(String(url), String(scopeUrl));
  } catch {
    return false;
  }
  try {
    scope = new URL(String(scopeUrl), u.href);
  } catch {
    return false;
  }
  // WHY same-origin only: cross-origin responses are opaque and cannot be
  // validated or safely stored.
  if (u.origin !== scope.origin) return false;
  // Resolve asset dirs relative to the SW scope so the app also works from a
  // sub-path (e.g. GitHub Pages project sites).
  let base = scope.pathname;
  if (!base.endsWith("/")) base = base.slice(0, base.lastIndexOf("/") + 1);
  if (!u.pathname.startsWith(base)) return false;
  const rel = u.pathname.slice(base.length);
  return CACHED_DIRS.some((d) => rel === d.slice(0, -1) || rel.startsWith(d));
}
