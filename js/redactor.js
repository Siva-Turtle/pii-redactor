// Combines the two redaction layers behind one small API:
//
//   const r = new Redactor({ dates: false, detector });  // detector optional (GLiNER)
//   await r.learn(allTextsInTheFile, onProgress);        // AI pass: discover names/addresses
//   r.spans(text)  -> [{start,end,type,source,...}]      // where PII sits in `text`
//   r.apply(text)  -> "…[NAME]…"                         // replaced text (also counts it)
//
// Layer 1 (patterns.js) finds fixed-format identifiers. Layer 2 (GLiNER, via
// `detector`) discovers names and addresses; each one found is then redacted
// EVERYWHERE it occurs in the file, not only in the window that revealed it.
//
// Provenance: every span carries where it was found so the per-file
// `redactor.report` can list the exact original quote, its type and who found
// it. Sources: "script" (regex rule), "cue" (deterministic name cue),
// "gliner" (GLiNER model), "needle" (legacy Cactus Needle path, kept for
// tests), "you" (user's manual list),
// "column" (whole spreadsheet/CSV column hidden by its header).

import { NOT_A_SECRET, applySpans, findPatternSpans, labelFor } from "./patterns.js";
import { hasAddressWord, isCommonWord } from "./common-words.js";
import { extractHeader } from "./statement-header.js";
// (Address vocabulary lives in common-words.js ADDRESS_WORDS.)

// Needle is only reliable on short, sentence-sized input (measured), so text is
// split per sentence/line; only tiny neighbouring fragments are merged.
const CHUNK_MAX = 200;
const CHUNK_MERGE = 30;
// GLiNER scores one ~300-char window per call for all PII labels together
// (Knowledgator pii-small, token-level). Single threshold 0.4 for every label.
const GLINER_WINDOW = 300;
const GLINER_MIN = 0.4;
// WHY closest existing type: the report/apply pipeline only knows these
// buckets; DOB is never asked for (dates stay visible by user decision).
const GLINER_LABEL_KIND = {
  person: "NAME",
  address: "ADDRESS",
  "PAN number": "PAN",
  "folio number": "FOLIO",
  "phone number": "PHONE",
  email: "EMAIL",
  "customer id": "ID",
  "bank account number": "ACCOUNT",
  "passport number": "ID",
};
// Statement vocabulary and share-plan words that GLiNER mistakes for
// people/places; keeps stock names, dates and amounts readable.
const GLINER_NOT_PII = /\b(?:GSUs?|RSUs?|Vest(?:ed|ing)?|Page|Grant|Tax|IRS|Alien|Nonresident|Account|Summary|Total|Release|Plan|Share|Savings|Stock|Price|Value|Activity|Balance|Dividend|Inc|Alphabet|Google|Class|NASDAQ)\b|^[A-Z]{2,6}$|\d{1,2}-[A-Z][a-z]{2}-\d{4}/;
// Generic statement labels GLiNER reports as person/address ("Investor",
// "email id", "demat account(s)", "KRA Data", "Registrar", ...). Matched
// case-insensitively on the whole hit after trimming punctuation; singular,
// plural and a trailing "(s)" all count. Exported for tests.
export const GENERIC_GLINER_STOP_RE =
  /^(?:investors?|address(?:es)?|emails?(?:\s+ids?)?|demat\s+accounts?(?:\(s\))?|kra\s+data|registrars?|transfer\s+agents?|statements?|folios?|schemes?|holders?|nominees?)$/i;
// Fund/product words: a person hit immediately next to one is part of a
// product name ("Motilal Oswal Nasdaq 100 FOF"), not a person.
const FUND_WORDS = new Set(
  ["fund", "funds", "fof", "index", "indexes", "indices", "etf", "etfs", "plan", "plans", "growth", "direct", "regular", "scheme", "schemes", "nasdaq", "s&p"],
);
// --- Step 2: model-hit filter (applied to every AI hit before it is accepted).
// Normalised form the filter matches on: trimmed, lower-cased, whitespace
// collapsed.
const normHit = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
// Generic label/relation words the model reports as PII ("self", "Nominee",
// "registered mobile"...). The trailing-s plural is also dropped.
const GENERIC_MODEL_WORDS = new Set(
  ["self", "spouse", "child", "children", "kid", "kids", "parent", "parents", "father", "mother", "ok", "yes", "no", "na", "nil",
    "address", "email", "email id", "e mail", "e-mail", "mobile", "mobile number", "phone", "investor", "investor name", "client",
    "pan", "kra", "kyc", "intermediary", "male", "female", "indian citizen", "account holder", "advisor", "registered email",
    "registered mobile", "nominee", "holder", "first holder", "second holder", "guardian", "name", "date of birth", "dob"],
);
// Job titles / roles: optional qualifier + base, plural ok.
const ROLE_RE =
  /^(?:(?:investment|insurance|relationship|service|asset|branch|wealth|account|principal)\s+)?(?:advisers?|advisors?|managers?|officers?|recipients?|providers?|persons?|insured(?:\s*\(?persons?\)?)?|employees?|ria|agents?|directors?|trustees?)s?$/;
// Words that cue a genuine ID nearby (digits-only hits need one, see below).
const ID_CUE_WORDS = ["folio", "account", "a/c", "acct", "client", "customer", "cust", "id", "number", "no", "ref", "member", "policy", "crn", "ucc", "dp", "bo", "demat", "iban", "card", "pran", "uan"];
// Money words (shared with the step-3 number guard): a label carrying one
// means the nearby number is an amount. invest*/tax* are prefixes; the rest
// are whole words (so "emi" never matches inside "PREMISE").
const MONEY_WORDS_RE =
  /\b(?:amount|amt|balance|value|valuation|payments?|price|nav|units?|cost|loan|income|salary|expenses?|premium|corpus|total|invest\w*|gains?|loss(?:es)?|tax\w*|emi|rent|fees?|charges|interest|inr|aed|usd|rs|sgd|eur|gbp)\b/i;
const MONEY_SYMBOL_RE = /[₹$€£]/;
const wordRe = (w) => new RegExp(`(?<![A-Za-z])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z])`, "i");
const ID_CUE_RES = ID_CUE_WORDS.map(wordRe);
/** True when `text` holds an ID-cue word (folio, a/c, client id, ...) as a whole word. */
export function hasIdWord(text) {
  return ID_CUE_RES.some((re) => re.test(String(text || "")));
}
/** True when `text` holds a money word/symbol (amount, NAV, ₹, ...). */
export function hasMoneyWord(text) {
  const t = String(text || "");
  return MONEY_SYMBOL_RE.test(t) || MONEY_WORDS_RE.test(t);
}
/**
 * Label + column-header context for a hit inside `working` (shared by the
 * step-2 digits rule and the step-3 number guard). Non-tabbed lines: the last
 * 40 chars before the hit. Tabbed rows: the previous cell. Header: the same
 * column's cell in the block's first tab line.
 */
export function labelAndHeader(working, hit) {
  let m = null;
  try {
    m = new RegExp(wsRe(hit), "i").exec(working || "");
  } catch {
    return { label: "", header: "" };
  }
  if (!m) return { label: "", header: "" };
  return labelAndHeaderAt(working || "", m.index, m.index + m[0].length);
}

/** Span-based version of labelAndHeader (exact offsets, no re-search). */
export function labelAndHeaderAt(text, start, end) {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  let lineEnd = text.indexOf("\n", end);
  if (lineEnd < 0) lineEnd = text.length;
  const line = text.slice(lineStart, lineEnd);
  const at = start - lineStart;
  if (!line.includes("\t")) return { label: line.slice(Math.max(0, at - 40), at), header: "" };
  const cells = line.split("\t");
  let acc = 0, ci = 0;
  for (let i = 0; i < cells.length; i++) {
    if (at >= acc && at <= acc + cells[i].length) { ci = i; break; }
    acc += cells[i].length + 1;
    ci = i;
  }
  const cellStart = acc;
  const label = ci > 0 ? cells[ci - 1] : cells[ci].slice(0, Math.max(0, at - cellStart));
  // Block header: first tab line of the contiguous tab-line run above.
  let top = lineStart;
  for (;;) {
    const prevEnd = top - 1;
    if (prevEnd < 0) break;
    const prevStart = text.lastIndexOf("\n", prevEnd - 1) + 1;
    const prev = text.slice(prevStart, prevEnd);
    if (!prev.includes("\t")) break;
    top = prevStart;
  }
  const firstEnd = text.indexOf("\n", top);
  const first = text.slice(top, firstEnd < 0 ? text.length : firstEnd);
  const header = (first.split("\t")[ci] || "").trim();
  return { label: label || "", header: header === label ? "" : header };
}

// --- Step 3: number guard (keep amounts visible). Digits-only spans from the
// pattern/propagation layers that read as amounts stay visible.
const MONEY_FMT_RE = /^[₹$]?\s*\d{1,3}(?:,\d{2,3})*(?:,\d{3})(?:\.\d+)?$/;
const MONEY_DEC_RE = /^[₹$]?\s*\d+\.\d{1,2}$/;
const lastMatchPos = (re, text) => {
  re.lastIndex = 0;
  let last = -1, m;
  while ((m = re.exec(text))) {
    last = m.index;
    if (!m[0].length) break;
  }
  return last;
};
const lastSymbolPos = (text) => Math.max(text.lastIndexOf("₹"), text.lastIndexOf("$"), text.lastIndexOf("€"), text.lastIndexOf("£"));
const ID_CUE_GLOBAL = new RegExp(ID_CUE_RES.map((r) => r.source).join("|"), "gi");
const MONEY_GLOBAL = new RegExp(MONEY_WORDS_RE.source, "gi");
/** True when a digits-only span reads as an amount (stays visible). Exported for tests. */
export function isAmountVisible(text, start, end) {
  const raw = text.slice(start, end);
  const t = raw.trim();
  if (/^[₹$]/.test(t)) return true; // leading ₹/$
  if (MONEY_FMT_RE.test(t) || MONEY_DEC_RE.test(t)) return true;
  const { label, header } = labelAndHeaderAt(text, start, end);
  const decide = (ctx) => {
    const idLast = lastMatchPos(ID_CUE_GLOBAL, ctx);
    const moneyLast = Math.max(lastMatchPos(MONEY_GLOBAL, ctx), lastSymbolPos(ctx));
    if (idLast < 0 && moneyLast < 0) return null; // no cue here
    return idLast <= moneyLast; // ID strictly after money hides; else visible
  };
  return decide(label) ?? decide(header) ?? false;
}
/** Digits with optional ₹/$, spaces, commas/decimals (no letters, no +/-/@). */
export function isDigitsOnlyText(s) {
  const t = String(s || "").trim();
  return /\d/.test(t) && /^[₹$\s]*\d[\d\s,.]*$/.test(t);
}
/**
 * Step-2 filter. True = drop this AI hit. Exported for tests.
 * `kind` is the mapped Redactor kind (NAME/ADDRESS/PAN/...), `working` the
 * window text the hit came from (for the digits-only ID-cue check).
 */
export function isFilteredModelHit(hit, kind, working) {
  const n = normHit(hit);
  if (!n) return true;
  if (GENERIC_MODEL_WORDS.has(n)) return true;
  if (n.endsWith("s") && GENERIC_MODEL_WORDS.has(n.slice(0, -1))) return true;
  if (ROLE_RE.test(n)) return true;
  if (/^[a-z]{1,4}$/.test(n)) return true;
  const up = n.toUpperCase();
  if (/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(up)) return true; // ISIN
  if (/^IN[A-Z]\d{9}$/.test(up)) return true; // SEBI registration number
  try {
    if (findPatternSpans(hit.trim(), { dates: true }).some((sp) => sp.type === "DATE" && sp.end - sp.start === hit.trim().length)) return true;
  } catch {
    /* pattern layer must never break the AI path */
  }
  const digits = n.replace(/\D/g, "");
  // Amount-like: commas/decimals, or 6 digits or fewer.
  if (/\d/.test(n) && /[,.]/.test(n) && /^[\d\s,.$₹€£]*$/.test(n)) return true;
  if (/^[\d\s]*$/.test(n) && digits.length > 0 && digits.length <= 6) return true;
  // Digits-only (7+ digits, separators at most space/dot/slash/dash): kept
  // only with an ID cue and no money word nearby (the model marks amounts).
  if (/^\d[\d\s./-]*$/.test(n)) {
    const { label, header } = labelAndHeader(working || "", hit);
    const cue = `${label || ""} ${header || ""}`;
    if (!(hasIdWord(cue) && !hasMoneyWord(cue))) return true;
  }
  return false;
}
const MAX_RUNS = 12; // hard cap on Needle runs per chunk
const EMPTY_RUNS_TO_STOP = 2; // stop after this many consecutive runs that find nothing new
// Words that merely open a sentence; a capital letter on them says nothing.
const STARTERS = new Set(
  ("the this that these those there then they their them please kindly our your you his her with from for and but however also any all can could will would should what when where how why which who are was were has have had not its into over under before after about as at by if in is it of on or so to we").split(" "),
);
const TITLES = /^(?:mr|mrs|ms|miss|dr|shri|smt|sri|prof|mx)$/i;
const CORPORATE = /\b(?:pvt|ltd|limited|bank|inc|llc|llp|corp|wealth|capital|finance|fund|trust|services|technologies|solutions|group|company|co|insurance|securities|partners)\b/i;
const ADDRESS_HINT =
  /\d|\b(?:road|rd|street|st|lane|nagar|colony|apartments?|flat|floor|sector|avenue|ave|blvd|marg|society|plot|block|tower|residency|layout|cross|main)\b/i;
// ISIN line detector for the step-4 security vocabulary (same shape as the
// silent pattern-layer ISIN rule: INE/INF + 9 alphanumerics).
const ISIN_LINE_RE = /\b(?:INE|INF)[0-9A-Z]{9}\b/i;

// Capitalised words the model sometimes reports on their own; never a name.
const NOT_A_NAME = new Set(
  ("dear hi hello hey regards thanks thank sincerely yours please registered client customer account address " +
    "contact mobile phone email name sir madam team office branch bank date amount total note notes " +
    "dob pan aadhaar aadhar ssn gst ifsc upi monday tuesday wednesday thursday friday saturday sunday january february march april may june july august " +
    "september october november december india indian mumbai delhi bengaluru bangalore chennai kolkata pune hyderabad").split(" "),
);
const LEADING_NOISE = /^(?:(?:dear|hi|hello|hey|attn|attention)[\s,:]+|(?:mr|mrs|ms|miss|dr|shri|smt|sri|prof)\.?\s+)/i;

/** Strip greetings/titles the model sometimes includes, and trailing punctuation. */
export function cleanHit(hit) {
  let h = hit.trim();
  for (let prev = ""; prev !== h; ) {
    prev = h;
    h = h.replace(LEADING_NOISE, "").trim();
  }
  return h.replace(/[\s,;:.]+$/, "");
}

// Amounts, currency values and percentages are never PII; the 9+ digit carve-out
// keeps long digit strings (account-like) eligible for the ID path below.
const MONEY = /^[\s(\-+]*(?:(?:US|A|C|S|HK)?\$|USD|INR|Rs\.?|₹|€|£|¥)?\s*[\d,]+(?:\.\d+)?\s*(?:%|USD|INR|CR|DR|cr|dr|[KMB]n?)?[\s)]*$/;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wsRe = (s) => escapeRe(s).replace(/\s+/g, "\\s+");
const normKey = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();

// Pattern-found identifiers that must hide everywhere, even without their
// label: a DEMAT/FOLIO/ACCOUNT/ID value seen once with its label is
// remembered in normalised form (uppercase, alphanumerics only) and matched
// tolerantly (single spaces/hyphens between chars, brackets/punctuation
// around it). FOLIO also remembers the number before a "/ NN" suffix.
const PROP_TYPES = new Set(["DEMAT", "FOLIO", "ACCOUNT", "ID"]);
const normId = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Whole-hit generic label? Case-insensitive, trailing punctuation ignored. */
export function isGenericGlinerStop(hit) {
  const n = String(hit || "").trim().replace(/[\s,;:.]+$/, "").trim();
  return n.length > 0 && GENERIC_GLINER_STOP_RE.test(n);
}

/**
 * Fund/product context? True when a fund word sits inside the hit or in the
 * ~3 words immediately before/after it in the window. Shared by _learnGliner
 * (GLiNER window) and _accept (Needle working text) so both paths agree.
 */
export function isFundAdjacent(hit, window) {
  const h = String(hit || "").trim();
  const w = String(window || "");
  if (!h || !w) return false;
  const norm = (t) => t.replace(/^[^A-Za-z&]+|[^A-Za-z&]+$/g, "").toLowerCase();
  if (h.split(/\s+/).some((t) => FUND_WORDS.has(norm(t)))) return true;
  let m;
  try {
    m = new RegExp(wsRe(h), "i").exec(w);
  } catch {
    return false;
  }
  if (!m) return false;
  const before = w.slice(0, m.index).trim().split(/\s+/).filter(Boolean).slice(-3);
  const after = w.slice(m.index + m[0].length).trim().split(/\s+/).filter(Boolean).slice(0, 3);
  return [...before, ...after].some((t) => FUND_WORDS.has(norm(t)));
}

/** Split text into model-sized chunks on sentence/line breaks. */
export function chunkText(text) {
  const pieces = [];
  for (const raw of text.split(/(?<=[.!?])\s+|\n+/)) {
    let p = raw.trim().replace(/^(?:[-*•>#]+|\d+[.)])\s+/, "");
    while (p.length > CHUNK_MAX) {
      let cut = Math.max(p.lastIndexOf(", ", CHUNK_MAX), p.lastIndexOf("; ", CHUNK_MAX), p.lastIndexOf(" ", CHUNK_MAX));
      if (cut < 40) cut = CHUNK_MAX;
      pieces.push(p.slice(0, cut + 1).trim());
      p = p.slice(cut + 1).trim();
    }
    if (p) pieces.push(p);
  }
  const chunks = [];
  for (const p of pieces) {
    const last = chunks.length - 1;
    if (last >= 0 && chunks[last].length + p.length < CHUNK_MERGE)
      chunks[last] += ` ${p}`;
    else chunks.push(p);
  }
  return chunks;
}

const KINDS = ["ADDRESS", "ACCOUNT", "ID", "SECRET", "NAME", "PII", "PAN", "FOLIO", "PHONE", "EMAIL"]; // match priority, highest first
const newTerms = () => Object.fromEntries(KINDS.map((k) => [k, new Set()]));
// Leading label words the model includes with a number ("DP ID 12081600").
const cleanValue = (hit) => hit.trim().replace(/^(?:[A-Za-z]+[\s:#]+)+(?=\S*\d)/, "").replace(/[\s,;:.]+$/, "");

/** Decide what a generic find_pii answer is, from its shape. null = not convincing enough to hide. */
function inferKind(hit) {
  if (/@/.test(hit)) return "ID";
  const words = hit.split(/\s+/);
  if (/\d/.test(hit)) {
    if (/,/.test(hit) || ADDRESS_HINT.test(hit.replace(/\d+/g, "")) || words.length > 3) return "ADDRESS";
    return "ID";
  }
  const titleCase = words.length <= 4 && words.every((w) => /^\p{Lu}[\p{L}'.-]+$/u.test(w));
  return titleCase && !CORPORATE.test(hit) ? "NAME" : null;
}

/** Turn the user's own list (exact words or lines) into one matcher; matching ignores case and extra spaces. */
export function buildManual(items) {
  const list = [...new Set(items.map((x) => x.replace(/\s+/g, " ").trim()).filter((x) => x.length >= 2))].sort((a, b) => b.length - a.length);
  if (!list.length) return null;
  const body = list.map((x) => `${/^[\p{L}\p{N}]/u.test(x) ? "(?<![\\p{L}\\p{N}])" : ""}${wsRe(x)}${/[\p{L}\p{N}]$/u.test(x) ? "(?![\\p{L}\\p{N}])" : ""}`).join("|");
  const re = new RegExp(body, "giu");
  // WHY attached: spans() maps each match back to the entry the user typed.
  re.entries = list;
  return re;
}

/**
 * Runs of 6–15 digits in an uploaded file name (people name files by
 * account/policy no). 8-digit 19/20 timestamps (20yymmdd…) are excluded.
 * Returns the digit runs. Exported for tests.
 */
export function fileNameIds(name) {
  const out = [];
  for (const m of String(name || "").matchAll(/\d{6,15}/g)) {
    const d = m[0];
    if (/^(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$/.test(d)) continue;
    out.push(d);
  }
  return out;
}

/** One edit away (substitution/insertion/deletion), case-insensitive. */
export function edits1(a, b) {
  const x = String(a || "").toLowerCase(), y = String(b || "").toLowerCase();
  if (x === y) return true;
  const lx = x.length, ly = y.length;
  if (Math.abs(lx - ly) > 1) return false;
  if (lx === ly) {
    let diff = 0;
    for (let i = 0; i < lx; i++) if (x[i] !== y[i] && ++diff > 1) return false;
    return true;
  }
  const [s, l] = lx < ly ? [x, y] : [y, x];
  let i = 0, j = 0, skipped = false;
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) {
      i++;
      j++;
    } else if (!skipped) {
      skipped = true;
      j++;
    } else return false;
  }
  return true;
}

/** Split what the user typed into items: commas and line breaks both separate. */
export function parseManual(text) {
  return String(text || "").split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
}

/**
 * Step-6 name variants for a trusted 2–4-word name "FIRST MIDDLE LAST":
 * "FIRST LAST", "LAST FIRST", "LAST FIRST MIDDLE", "FIRST M LAST" (initials).
 * Any case (the batch matcher is case-insensitive). Exported for tests.
 */
export function nameVariants(name) {
  const parts = String(name || "").trim().split(/\s+/).map((w) => w.replace(/\.+$/, "")).filter(Boolean);
  if (parts.length < 2 || parts.length > 4) return [];
  const first = parts[0], last = parts[parts.length - 1];
  const mid = parts.slice(1, -1).join(" ");
  const initial = parts[1] ? parts[1].replace(/\./g, "")[0] : "";
  const out = [`${first} ${last}`, `${last} ${first}`];
  if (mid) {
    out.push(`${last} ${first} ${mid}`);
    if (initial) out.push(`${first} ${initial} ${last}`);
  }
  const seen = new Set([String(name).trim().toLowerCase().replace(/\s+/g, " ")]);
  return out.filter((v) => {
    const k = v.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ------------------------------------------------------------------ report
export const REPORT_PRIVACY =
  "WARNING: This report contains the ORIGINAL sensitive text that was hidden. Keep it private and never send it along with the redacted file.";
export const REPORT_COLUMNS = ["file", "location", "page", "type", "quote", "found_by", "detail"];

/** found_by/detail pair for a report entry or span carrying provenance. */
export function provToFoundBy(s) {
  const src = s?.source;
  if (src === "cue") return { found_by: "script: name cue", detail: s.cue || "" };
  if (src === "column") return { found_by: "script: column header", detail: s.header || "" };
  if (src === "you") return { found_by: "you", detail: s.entry || "" };
  if (src === "gliner") return { found_by: "gliner", detail: `${s.label}, score ${s.score}` };
  if (src === "global") {
    // WHY batch-wide: the term was hidden in another file of the same batch;
    // `via` keeps the original layer's detail for the report.
    const v = s?.via || {};
    const d = v.label ? `${v.label}, score ${v.score}` : v.cue || v.rule || v.header || v.question || s?.type || "";
    return { found_by: "script: batch", detail: d };
  }
  if (src === "needle") {
    const q = s.question === "pii" ? "find_pii" : (s.question || "");
    return { found_by: "needle", detail: `${q}, run ${s.run ?? ""}, variant ${s.variant ?? ""}`.trim() };
  }
  return { found_by: "script", detail: s?.rule || s?.type || "" };
}

/**
 * Count occurrences of `term` in `haystack` with the global-match boundaries:
 * all-digit terms use digit-only edges, others word edges + flexible
 * whitespace, case-insensitive. Exported for tests.
 */
export function countOccurrences(haystack, term) {
  const t = String(term || "").replace(/\s+/g, " ").trim();
  if (!t) return 0;
  const esc = wsRe(t);
  const digitOnly = /^\d+$/.test(t.replace(/\s+/g, ""));
  let re;
  try {
    re = digitOnly
      ? new RegExp(`(?<!\\d)(?:${esc})(?!\\d)`, "gi")
      : new RegExp(`(?<![\\p{L}\\p{N}])(?:${esc})(?![\\p{L}\\p{N}])`, "giu");
  } catch {
    return 0;
  }
  let n = 0;
  for (const _ of String(haystack || "").matchAll(re)) n++;
  return n;
}

/**
 * Step-5 agreement check. `quotes` are pass-1 report entries (what any layer
 * hid in any file); `batchTexts` is every learn text of the batch. Returns
 * [{text, type, prov}] for terms that go batch-wide: whitespace-collapsed,
 * ≥4 chars (all-digit terms need ≥6 digits); ID-like terms (4+ digits or @)
 * always go on; other terms only when flagged in ≥30% of appearances.
 * Trusted (step-6 header) quotes skip the check via `trusted: true` prov.
 * Exported for tests.
 */
export function computeGlobals(batchTexts, quotes) {
  const all = [...(batchTexts || [])].join("\n");
  const flags = new Map();
  for (const q of quotes || []) {
    if (!q || q.source === "you") continue; // the manual list is already batch-wide
    const t = String(q.quote || "").replace(/\s+/g, " ").trim();
    if (!t) continue;
    const key = t.toLowerCase();
    const cur = flags.get(key) || { text: t, type: q.type || "ID", prov: { ...q, quote: undefined, start: undefined, end: undefined }, flags: 0 };
    cur.flags++;
    flags.set(key, cur);
  }
  const out = [];
  for (const f of flags.values()) {
    if (f.text.length < 4) continue;
    const digitsOnly = /^\d+$/.test(f.text.replace(/\s+/g, ""));
    if (digitsOnly && f.text.replace(/\D/g, "").length < 6) continue;
    if (f.prov?.trusted) {
      out.push({ text: f.text, type: f.type, prov: f.prov });
      continue;
    }
    if (/\d{4}|@/.test(f.text)) {
      out.push({ text: f.text, type: f.type, prov: f.prov });
      continue;
    }
    const total = countOccurrences(all, f.text);
    if (total > 0 && f.flags / total >= 0.3) out.push({ text: f.text, type: f.type, prov: f.prov });
  }
  // WHY longest first: the batch matcher tries longer terms before shorter ones.
  out.sort((a, b) => b.text.length - a.text.length);
  return out;
}

/**
 * Step-5 address parts. From hidden spans that look like an address (they
 * contain an address word, or all their letter-words are common/place words)
 * and contain no www/@/http: every 5+ digit run plus every comma/hyphen
 * piece with 2+ words that holds an address word and is not all common
 * words. Returns [{text, type}] candidates for computeGlobals-style gating
 * (callers count them as flagged once). Exported for tests.
 */
export function deriveAddressParts(quotes) {
  const out = [];
  const seen = new Set();
  const push = (text, type) => {
    const t = String(text || "").replace(/\s+/g, " ").trim();
    if (t.length < 4 || seen.has(t.toLowerCase())) return;
    seen.add(t.toLowerCase());
    out.push({ text: t, type });
  };
  for (const q of quotes || []) {
    const raw = String(q?.quote || "").replace(/\s+/g, " ").trim();
    if (!raw || /www|@|http/i.test(raw)) continue;
    const letterWords = raw.split(/[\s,;\-]+/).filter((w) => /[A-Za-z]/.test(w)).map((w) => w.toLowerCase().replace(/[^a-z]/g, ""));
    if (!letterWords.length) continue;
    if (!hasAddressWord(raw) && !letterWords.every(isCommonWord)) continue;
    for (const m of raw.matchAll(/\d{5,}/g)) push(m[0], "ID");
    for (const piece of raw.split(/[,\-–—]+/)) {
      const p = piece.trim();
      const words = p.split(/\s+/).filter(Boolean);
      if (words.length < 2 || !hasAddressWord(p)) continue;
      if (words.every((w) => isCommonWord(w))) continue;
      push(p, "ADDRESS");
    }
  }
  return out;
}

/** Human-readable "found by" for the on-page table, e.g. `script (PAN)`. */
export function formatFound(s) {
  const { found_by, detail } = provToFoundBy(s);
  return detail ? `${found_by} (${detail})` : found_by;
}

const INJECTION_LEAD = /^[=+\-@\t\r]/;
function csvCell(v) {
  let s = String(v ?? "");
  // Guard against spreadsheet formula injection: a leading ' neutralises =, +, -, @.
  if (INJECTION_LEAD.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Build the downloadable report CSV (UTF-8 with BOM for Excel). Rows carry file/location/page/type/quote/found_by/detail. */
export function buildReportCsv(rows) {
  const lines = [`# ${REPORT_PRIVACY}`, REPORT_COLUMNS.map(csvCell).join(",")];
  for (const r of rows) {
    const { found_by, detail } = provToFoundBy(r);
    lines.push(
      [r.file ?? "", r.location ?? "", r.page ?? "", r.type ?? "", r.quote ?? "", found_by, r.detail ?? detail]
        .map(csvCell)
        .join(","),
    );
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}

export class Redactor {
  constructor({ dates = true, detector = null, thorough = true, manual = [], aiCache = null } = {}) {
    this.dates = dates;
    this.manual = buildManual(manual);
    // Thorough: keep asking until nothing new turns up in two runs in a row. Quick: one.
    this.emptyRunsToStop = thorough ? EMPTY_RUNS_TO_STOP : 1;
    this.detector = detector;
    this.aiCache = aiCache || new Map(); // step-5: window text -> AI ents, shared batch-wide
    this.batchTexts = new Set(); // step-5: every text passed to learn(), for agreement counts
    this.globals = []; // step-5: batch-wide terms {text,type,prov,digitOnly}
    this._globalRe = null; // combined global matcher, rebuilt when globals change
    this.terms = newTerms();
    this.tokens = new Set(); // single first/last names, matched case-sensitively
    this.counts = {};
    this.seen = new Set();
    this._compiled = null;
    this.report = []; // per-file redaction report entries (in-memory only)
    this.termProv = new Map(); // norm term -> {source,...}, first discovery wins
    this.tokenProv = new Map(); // exact token -> {source,...}
    this.propagated = new Map(); // norm id -> {type,source,rule}, first labelled hit wins
    this._propRe = null; // combined propagated-ID matcher, rebuilt when propagated.size changes
    this._propReSize = 0;
    this._learned = new Set(); // texts already passed to _learnPatterns
    this.securityWords = new Set(); // step-4 fund-name vocabulary (ISIN lines ±)
    this.trusted = new Map(); // step-6 statement-header values: norm -> {type,source,...}
    this.trustedRe = null; // combined trusted matcher, rebuilt when trusted changes
  }

  /** Reset only the per-file tally/report (batch pass 2 keeps knowledge). */
  resetCounts() {
    this.counts = {};
    this.report = [];
  }

  /** Reset the per-file tally (terms learned in earlier files are kept out too). */
  resetFile() {
    this.resetCounts();
    this.terms = newTerms();
    this.tokens = new Set();
    this.seen = new Set();
    this._compiled = null;
    this.termProv = new Map();
    this.tokenProv = new Map();
    this.propagated = new Map();
    this._propRe = null;
    this._propReSize = 0;
    this._learned = new Set();
    this.securityWords = new Set();
    this.trusted = new Map();
    this.trustedRe = null;
    this.globals = [];
    this._globalRe = null;
    this.batchTexts = new Set();
  }

  /**
   * AI pass. `texts` is every text fragment of the file. Returns how many
   * chunks were scanned and whether the budget cut the scan short.
   */
  /**
   * WHY propagation: a labelled ID (DP ID: IN302814) must also hide where it
   * appears without its label ((IN302814), a table cell, its own line). Runs
   * over every text passed to learn() so earlier pages learn from later ones.
   */
  _learnPatterns(text) {
    if (!text) return;
    let spans;
    try {
      spans = findPatternSpans(text, { dates: true });
    } catch {
      return;
    }
    for (const s of spans) {
      if (!PROP_TYPES.has(s.type)) continue;
      const raw = text.slice(s.start, s.end);
      const norm = normId(raw);
      // WHY length + digit + common-word guards: short codes and plain words
      // (pin code, policy) must never become file-wide matchers.
      if (norm.length < 5 || !/\d/.test(norm)) continue;
      if (NOT_A_SECRET.test(raw.trim())) continue;
      if (!this.propagated.has(norm)) this.propagated.set(norm, { type: s.type, source: s.source, rule: s.rule });
      // WHY folio base: "12345678 / 45" elsewhere shares only the number
      // before the "/ NN" suffix, so that part hides on its own.
      if (s.type === "FOLIO" && raw.includes("/")) {
        const base = normId(raw.split("/")[0]);
        if (base.length >= 5 && /\d/.test(base) && !this.propagated.has(base))
          this.propagated.set(base, { type: s.type, source: s.source, rule: s.rule });
      }
    }
  }

  /** Tolerant file-wide matches for propagated IDs, honouring `taken`. */
  _propSpans(text, taken) {
    const out = [];
    if (!this.propagated.size) return out;
    // WHY one combined regex: per-ID RegExp per call is too slow on big files.
    // Rebuilt only when propagated.size changes; alternation stays longest
    // first so a folio base and its full form overlap with the longer winning.
    if (!this._propRe || this._propReSize !== this.propagated.size) {
      const keys = [...this.propagated.keys()].filter((k) => k.length >= 5).sort((a, b) => b.length - a.length);
      if (!keys.length) {
        this._propRe = null;
        this._propReSize = this.propagated.size;
        return out;
      }
      // WHY single separator only: "IN 302814" matches, but prose spanning
      // two words never fuses into an ID.
      const body = keys.map((k) => k.split("").join("[ \\-]?")).join("|");
      try {
        this._propRe = new RegExp(`(?<![A-Za-z0-9])(?:${body})(?![A-Za-z0-9])`, "gi");
      } catch {
        this._propRe = null;
        this._propReSize = this.propagated.size;
        return out;
      }
      this._propReSize = this.propagated.size;
    }
    const re = this._propRe;
    if (!re) return out;
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      // WHY normId lookup: the tolerant match (spaces/hyphens, any case)
      // normalises back to the propagated key that owns the provenance.
      const prov = this.propagated.get(normId(m[0]));
      if (!prov) continue;
      const start = m.index;
      const end = start + m[0].length;
      let free = true;
      for (let i = start; i < end; i++) {
        if (taken[i]) {
          free = false;
          break;
        }
      }
      if (!free) continue;
      taken.fill(1, start, end);
      // WHY script provenance: the report still says which pattern rule
      // first found the value, even though it appears here without a label.
      out.push({ start, end, type: prov.type, source: prov.source, rule: prov.rule });
    }
    return out;
  }

  // --- Step 5: batch-wide (global) PII. Every string any layer hid in any
  // file is searched for in every file, so a name labelled in file A hides
  // bare in file B. Non-ID terms need agreement (flagged in >=30% of the
  // places they appear) so one-off model slips do not spread; ID-like terms
  // (4+ digits or @) always go on.
  /** Add one batch-wide term (from computeGlobals). */
  addGlobal(text, type, prov) {
    const t = String(text || "").replace(/\s+/g, " ").trim();
    if (!t) return;
    const stored = { source: "global", via: prov || {}, type };
    this.globals.push({ text: t, type, prov: stored, digitOnly: /^\d+$/.test(t.replace(/\s+/g, "")) });
    this._globalRe = null;
    // WHY tokens too: a global "Ravi Sharma" hides lone "Ravi"/"Sharma" as
    // well, exactly like a file-local learned NAME does.
    if (type === "NAME" && !/\d/.test(t)) {
      const words = t.split(" ");
      if (words.length <= 3 && !CORPORATE.test(t)) {
        for (const w of words) {
          if (/^\p{Lu}\p{L}{3,}$/u.test(w) && !TITLES.test(w) && !this.tokens.has(w)) {
            this.tokens.add(w);
            if (!this.tokenProv.has(w)) this.tokenProv.set(w, stored);
          }
        }
      }
    }
    this._compiled = null;
  }

  /** Batch-wide matches for global terms, honouring `taken`. */
  _globalSpans(text, taken) {
    const out = [];
    if (!this.globals.length) return out;
    if (!this._globalRe) {
      // WHY longest first: "Ravi Sharma" must win over "Ravi" at the same spot.
      const sorted = [...this.globals].sort((a, b) => b.text.length - a.text.length);
      // WHY two matchers: all-digit terms use digit-only boundaries so an ID
      // glued to a letter ("X987654321" style) is still caught; other terms
      // use word boundaries with flexible whitespace, case-insensitive.
      const wordParts = [];
      const digitParts = [];
      for (const g of sorted) {
        const esc = wsRe(g.text);
        if (g.digitOnly) digitParts.push(`(?<!\\d)(?:${esc})(?!\\d)`);
        else wordParts.push(esc);
      }
      try {
        this._globalRe = {
          word: wordParts.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${wordParts.join("|")})(?![\\p{L}\\p{N}])`, "giu") : null,
          digit: digitParts.length ? new RegExp(`(?:${digitParts.join("|")})`, "gi") : null,
        };
      } catch {
        return out;
      }
    }
    const push = (m, re) => {
      const start = m.index;
      const end = start + m[0].length;
      for (let i = start; i < end; i++) if (taken[i]) return;
      taken.fill(1, start, end);
      const g = this.globals.find((x) => normKey(x.text) === normKey(m[0]));
      if (g) out.push({ start, end, type: g.type, source: "global", via: g.prov });
      void re;
    };
    if (this._globalRe.word) {
      this._globalRe.word.lastIndex = 0;
      for (const m of text.matchAll(this._globalRe.word)) push(m, this._globalRe.word);
    }
    if (this._globalRe.digit) {
      this._globalRe.digit.lastIndex = 0;
      for (const m of text.matchAll(this._globalRe.digit)) push(m, this._globalRe.digit);
    }
    return out;
  }

  async learn(texts, { onProgress, maxChunks = Infinity, maxMs = Infinity } = {}) {
    const textsList = (texts || []).filter(Boolean);
    // WHY headers first: family first names (below) need every trusted
    // surname, even one learned from a later text in the same batch.
    for (const t of textsList) {
      this.batchTexts.add(t);
      this._learnHeader(t);
    }
    for (const t of textsList) {
      this._learnCues(t);
      this._learnPatterns(t);
      this._learnSecurity(t);
      this._learned.add(t);
    }
    // WHY after everything: family names need the complete trusted set.
    for (const t of textsList) this._learnFamily(t);
    // WHY last: address blocks build on the complete trusted set.
    for (const t of textsList) this._learnAddressBlocks(t);
    if (!this.detector) return { scanned: 0, total: 0, truncated: false };
    // GLiNER detectors expose recognize(); anything else is the legacy
    // per-question Needle path kept for tests.
    if (this.detector.recognize) return this._learnGliner(texts, { onProgress, maxChunks, maxMs });
    // The model is local, so it sees the original text: placeholders such as
    // "[EMAIL]" or "X" measurably confuse it. Pattern hits are masked only to
    // decide whether a chunk is worth asking about.
    const chunks = new Map();
    for (const t of texts) {
      if (!t) continue;
      for (const c of chunkText(t)) if (/\p{L}{3,}/u.test(c)) chunks.set(c, true);
    }
    const list = [...chunks.keys()];
    const total = Math.min(list.length, maxChunks);
    const started = Date.now();
    let next = 0;
    let done = 0;
    // One chunk per Needle session at a time; each chunk fires all its questions at once.
    const lane = async () => {
      while (next < total && Date.now() - started < maxMs) {
        await this._scanChunk(list[next++]);
        done++;
        onProgress?.(done, total);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(this.detector.size || 1, total)) }, lane));
    return { scanned: done, total: list.length, truncated: done < list.length };
  }

  /** GLiNER pass. One call per ~300-char window asks for all PII labels together. */
  async _learnGliner(texts, { onProgress, maxChunks = Infinity, maxMs = Infinity }) {
    const wins = new Map();
    for (const t of texts) {
      if (!t) continue;
      let cur = "";
      for (const l of t.split(/\n+/).map((x) => x.trim()).filter(Boolean)) {
        if (cur && cur.length + l.length > GLINER_WINDOW) { wins.set(cur, true); cur = ""; }
        cur = cur ? cur + "\n" + l : l;
      }
      if (cur) wins.set(cur, true);
    }
    // A window with no capitalised word, digit run or @ cannot hold PII, so
    // the model never needs to see it. (IDs/phone/email windows may have no
    // capitalised words, so digits and @ also qualify.)
    const STATEMENT_WORDS = /^(?:Outstanding|Distributed|Forfeited|Accumulated|Unvested|Currently|Processing|Deposit|Starting|From|Name|Date|Description|Quantity|Amount|Cost|Basis|Gain|Loss|Sale|Sold|Purchase|Transaction|Holdings|Position|Market|Closing|Opening|Period|Company|Number|Summary|Future|Available|Remainder|After|Change|History|Currencies|Dollars|United|States|Specified|Unless|All)$/;
    const hasCandidate = (w) =>
      (w.match(/\p{Lu}\p{L}{2,}/gu) || []).some((x) => !GLINER_NOT_PII.test(x) && !STATEMENT_WORDS.test(x)) ||
      /\d{5,}|@/.test(w);
    const list = [...wins.keys()].filter((w) => /\p{L}{3,}|\d{5,}|@/u.test(w) && hasCandidate(w));
    const total = Math.min(list.length, maxChunks);
    const started = Date.now();
    let done = 0;
    let next = 0;
    const lane = async () => {
      while (next < total && Date.now() - started < maxMs) {
        const w = list[next++];
        // WHY cache: pass 2 of the batch flow re-learns the same windows;
        // cached ents mean the model never runs twice on one window.
        let ents = this.aiCache.get(w);
        if (!ents) {
          ents = await this.detector.recognize(w, GLINER_MIN);
          this.aiCache.set(w, ents);
        }
        for (const e of ents) {
          const kind = GLINER_LABEL_KIND[e.label];
          if (!kind || (e.score ?? 0) < GLINER_MIN) continue;
          const raw = String(e.word || "").replace(/\s+/g, " ").trim();
          if (!raw) continue;
          // WHY shared helper here as well as in _accept: the GLiNER window is
          // available at this point, so product names skip before grounding;
          // _accept repeats the check on its working text for the older path.
          if (kind === "NAME" && isFundAdjacent(raw, w)) continue;
          const found = this._accept(raw, kind, w.replace(/\n/g, " "));
          if (found) this._addTerm(found.term, found.kind, { source: "gliner", label: e.label, score: +Number(e.score || 0).toFixed(2) });
        }
        onProgress?.(++done, total);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(this.detector.size || 1, total)) }, lane));
    return { scanned: done, total: list.length, truncated: done < list.length };
  }

  // --- Step 4: security names stay visible. Words on an ISIN's line and
  // the 2 lines after it (plus 1 before) name a security/fund. A no-digit
  // learned span whose words are all such words is not PII ("HDFC Flexi Cap
  // Fund" must survive a model calling it a person).
  _learnSecurity(text) {
    if (!text || !ISIN_LINE_RE.test(text)) return;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!ISIN_LINE_RE.test(lines[i])) continue;
      for (let j = Math.max(0, i - 1); j <= Math.min(lines.length - 1, i + 2); j++) {
        for (const w of lines[j].split(/\s+/)) {
          const n = w.toLowerCase().replace(/[^a-z]/g, "");
          if (n) this.securityWords.add(n);
        }
      }
    }
  }

  /** True when a learned span is a security/fund name (stays visible). */
  _isSecurityName(spanText) {
    if (!this.securityWords.size || /\d/.test(spanText)) return false;
    const words = String(spanText).split(/\s+/).map((w) => w.toLowerCase().replace(/[^a-z]/g, "")).filter(Boolean);
    return words.length > 0 && words.every((w) => this.securityWords.has(w));
  }

  // --- Step 6: statement-header layer. Investor-block values (name, address
  // lines, email, mobile, PAN, folios, client/BO ids, nominees, holders) are
  // trusted: they skip the agreement check and are searched batch-wide, with
  // name variants and surname widening (family members share a surname).
  _learnHeader(text) {
    let found;
    try {
      found = extractHeader(text);
    } catch {
      return;
    }
    for (const h of found) {
      const key = normKey(h.value);
      if (!this.trusted.has(key)) this.trusted.set(key, { text: h.value, type: h.type, variant: false });
      if (h.type === "NAME") {
        for (const v of nameVariants(h.value)) {
          const k = normKey(v);
          if (!this.trusted.has(k)) this.trusted.set(k, { text: v, type: "NAME", variant: true });
        }
      }
    }
  }

  // --- Step 7: family first names. For each trusted surname (5+ letters),
  // 1–3 capitalised words directly before it ("ANITA RAVI SHARMA") are family
  // given names: each 4+ letter word that is not common and not a surname is
  // hidden batch-wide when alone, case-sensitively (capital first letter).
  _learnFamily(text) {
    if (!text || !this.trusted.size) return;
    // WHY originals only: variants ("Desai Anita") put a given name last;
    // widening/family must follow the true surname.
    const surnames = [...new Set(
      [...this.trusted.values()]
        .filter((v) => v.type === "NAME" && !v.variant)
        .map((v) => (v.text.split(" ").pop() || "").replace(/\./g, ""))
        .filter((s) => /^[A-Za-z]{5,}$/.test(s)),
    )];
    if (!surnames.length) return;
    let re;
    try {
      // WHY case-insensitive surname: statements print "SHARMA" while the
      // header holds "Sharma"; the capital-first check below still guards
      // the given names themselves. The left edge excludes emails/glued
      // words ("anita.desai", "RAVISHARMA") from opening a family match.
      re = new RegExp(`(?<![\\p{L}\\p{N}_.@])((?:\\b[A-Z][A-Za-z]*\\.?\\s+){1,3})(${surnames.map(escapeRe).join("|")})\\b`, "giu");
    } catch {
      return;
    }
    let found = false;
    for (const m of text.matchAll(re)) {
      for (const raw of m[1].split(/\s+/).filter(Boolean)) {
        const w = raw.replace(/\./g, "");
        const letters = w.replace(/[^A-Za-z]/g, "");
        if (letters.length < 4 || !/^[A-Z]/.test(w)) continue;
        if (isCommonWord(letters)) continue;
        if (surnames.some((s) => s.toLowerCase() === letters.toLowerCase())) continue;
        if (!this.tokens.has(w)) {
          this.tokens.add(w);
          if (!this.tokenProv.has(w)) this.tokenProv.set(w, { source: "cue", cue: "family first name" });
          found = true;
        }
      }
    }
    if (found) this._compiled = null;
  }

  // --- Step 8: address blocks. A line that equals a trusted full name
  // (whitespace/case-insensitive) is itself fully hidden, so it opens a
  // block: up to 4 following lines hide while each holds an address word or
  // a digit. Stops at an empty line, a labelled/section line, or a line
  // ending with ":". Learned as trusted so it works in every format.
  _learnAddressBlocks(text) {
    if (!text || !this.trusted.size) return;
    const names = new Set(
      [...this.trusted.values()].filter((v) => v.type === "NAME").map((v) => normKey(v.text)),
    );
    if (!names.size) return;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!names.has(normKey(lines[i]))) continue;
      for (let j = i + 1; j < Math.min(lines.length, i + 5); j++) {
        const t = lines[j].trim();
        if (!t) break;
        if (/^(?:pan|tan|status|gstin|mob|tel|phone|e-?mail|dear|subject|your|this|date|name|form|assessment|period|summary|certificate|statement|page|sr|s\.no)\b/i.test(t) || /:$/.test(t)) break;
        if (!(hasAddressWord(t) || /\d/.test(t))) break;
        const key = normKey(t);
        if (!this.trusted.has(key)) this.trusted.set(key, { text: t, type: "ADDRESS" });
      }
    }
  }

  /** Trusted name words (4+ letters, not common) for OCR/narration rules. */
  _trustedNameWords() {
    const words = [];
    const seen = new Set();
    for (const v of this.trusted.values()) {
      if (v.type !== "NAME") continue;
      for (const w of String(v.text).split(/\s+/)) {
        const clean = w.replace(/[^A-Za-z]/g, "");
        const key = clean.toLowerCase();
        if (clean.length >= 4 && !isCommonWord(clean) && !seen.has(key)) {
          seen.add(key);
          words.push(clean);
        }
      }
    }
    return words;
  }

  /** Trusted values (+variants) and surname-widened family names, honouring `taken`. */
  _trustedSpans(text, taken) {
    const out = [];
    if (!this.trusted.size) return out;
    const sorted = [...this.trusted.values()].sort((a, b) => b.text.length - a.text.length);
    let re = null;
    try {
      re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${sorted.map((g) => wsRe(g.text)).join("|")})(?![\\p{L}\\p{N}])`, "giu");
    } catch {
      re = null;
    }
    if (re) {
      re.lastIndex = 0;
      for (const m of text.matchAll(re)) {
        const start = m.index, end = start + m[0].length;
        let free = true;
        for (let i = start; i < end; i++) {
          if (taken[i]) {
            free = false;
            break;
          }
        }
        if (!free) continue;
        const hit = this.trusted.get(normKey(m[0]));
        if (!hit) continue;
        taken.fill(1, start, end);
        out.push({ start, end, type: hit.type, source: "script", rule: "header", trusted: true });
      }
    }
    // Surname widening: a trusted surname of 5+ letters hides with up to two
    // capitalised words / initials on either side on the same line
    // (originals only; variants would widen around a given name).
    const surnames = new Set();
    for (const v of this.trusted.values()) {
      if (v.type !== "NAME" || v.variant) continue;
      const parts = v.text.split(" ").map((w) => w.replace(/\./g, ""));
      const last = parts[parts.length - 1] || "";
      if (/^[A-Za-z]{5,}$/.test(last)) surnames.add(last);
    }
    if (surnames.size) {
      const lines = text.split("\n");
      let off = 0;
      const capRe = /^[A-Z][A-Za-z]*\.?$/;
      for (const line of lines) {
        const lineStart = off;
        off += line.length + 1;
        if (CORPORATE.test(line)) continue; // a company sharing the name stays readable
        for (const sur of surnames) {
          let sre;
          try {
            sre = new RegExp(`(?<![A-Za-z])${escapeRe(sur)}(?![A-Za-z])`, "gi");
          } catch {
            continue;
          }
          for (const m of line.matchAll(sre)) {
            let a = m.index, b = m.index + m[0].length;
            for (let k = 0; k < 2; k++) {
              const prev = line.slice(0, a).match(/(\S+)\s*$/);
              if (prev && capRe.test(prev[1])) a -= prev[0].length;
              else break;
            }
            for (let k = 0; k < 2; k++) {
              const next = line.slice(b).match(/^\s*(\S+)/);
              if (next && capRe.test(next[1])) b += next[0].length;
              else break;
            }
            const start = lineStart + a, end = lineStart + b;
            let free = true;
            for (let i = start; i < end; i++) {
              if (taken[i]) {
                free = false;
                break;
              }
            }
            if (!free) continue;
            taken.fill(1, start, end);
            out.push({ start, end, type: "NAME", source: "script", rule: "header", trusted: true });
          }
        }
      }
    }
    return out;
  }

  // --- Step 8: PIN. A 6-digit number at the end of a line (trailing
  // letters/punctuation allowed) hides when the line has no tab, holds 3+
  // letters before it, and ≥40% of the non-space text before it is already
  // hidden (an address line). Tab lines are table rows, not PINs.
  _pinSpans(text, taken) {
    const out = [];
    let off = 0;
    for (const line of text.split("\n")) {
      const lineStart = off;
      off += line.length + 1;
      if (!line || line.includes("\t")) continue;
      const runs = [...line.matchAll(/(?<!\d)\d{6}(?!\d)/g)];
      if (!runs.length) continue;
      const m = runs[runs.length - 1]; // the number at the end of the line
      if (!/^[A-Za-z.,;:!?'"()\s]*$/.test(line.slice(m.index + 6))) continue;
      const before = line.slice(0, m.index);
      if ((before.match(/[A-Za-z]/g) || []).length < 3) continue;
      let hidden = 0, total = 0;
      for (let i = 0; i < before.length; i++) {
        if (before[i] === " ") continue;
        total++;
        if (taken[lineStart + i]) hidden++;
      }
      if (total <= 0 || hidden / total < 0.4) continue;
      const start = lineStart + m.index, end = start + 6;
      let free = true;
      for (let i = start; i < end; i++) {
        if (taken[i]) {
          free = false;
          break;
        }
      }
      if (!free) continue;
      taken.fill(1, start, end);
      out.push({ start, end, type: "PIN", source: "script", rule: "PIN" });
    }
    return out;
  }

  // --- Step 8: bank narrations. On lines holding UPI/NEFT/IMPS/RTGS/NACH/ACH/
  // ECS, a 4+ letter token between / - : delimiters that is a proper prefix
  // of a trusted name word (narrations cut names to a fixed width) hides.
  _narrationSpans(text, taken) {
    const out = [];
    const words = this._trustedNameWords();
    if (!words.length) return out;
    let off = 0;
    for (const line of text.split("\n")) {
      const lineStart = off;
      off += line.length + 1;
      if (!/\b(?:UPI|NEFT|IMPS|RTGS|NACH|ACH|ECS)\b/.test(line)) continue;
      for (const m of line.matchAll(/[A-Za-z]{4,}/g)) {
        const t = m[0];
        if (isCommonWord(t)) continue;
        const low = t.toLowerCase();
        if (!words.some((w) => w.length > low.length && w.toLowerCase().startsWith(low))) continue;
        // WHY between delimiters: the token must sit inside a /-:-separated
        // narration segment, not in free prose.
        const prev = line.slice(0, m.index).search(/[/:\-][^/:\-]*$/);
        const next = line.slice(m.index + t.length).search(/^[^/:\-]*[/:\-]/);
        if (prev < 0 || next < 0) continue;
        const start = lineStart + m.index, end = start + t.length;
        let free = true;
        for (let i = start; i < end; i++) {
          if (taken[i]) {
            free = false;
            break;
          }
        }
        if (!free) continue;
        taken.fill(1, start, end);
        out.push({ start, end, type: "NAME", source: "script", rule: "narration", trusted: true });
      }
    }
    return out;
  }

  // --- Step 8: OCR pages only (opts.ocr). A 5+ letter word one edit away
  // from a trusted name word (4+ letters, not common), or 2–3 trusted name
  // words glued together, hides (OCR drops spaces and misreads letters).
  _ocrSpans(text, taken) {
    const out = [];
    const words = this._trustedNameWords();
    if (!words.length) return out;
    const lower = words.map((w) => w.toLowerCase());
    const seen = new Set();
    const push = (start, end) => {
      for (let i = start; i < end; i++) if (taken[i]) return;
      taken.fill(1, start, end);
      out.push({ start, end, type: "NAME", source: "script", rule: "ocr", trusted: true });
    };
    for (const m of text.matchAll(/[A-Za-z]{5,}/g)) {
      const low = m[0].toLowerCase();
      if (seen.has(low)) continue;
      seen.add(low);
      if (lower.some((w) => w === low)) continue; // exact hits hide elsewhere
      if (lower.some((w) => edits1(low, w))) push(m.index, m.index + m[0].length);
    }
    // Glued trusted words ("RaviSharma" for "Ravi Sharma"), 2–3 at a time.
    const names = [...this.trusted.values()]
      .filter((v) => v.type === "NAME")
      .map((v) => String(v.text).split(/\s+/).map((w) => w.replace(/[^A-Za-z]/g, "")).filter((w) => w.length >= 4 && !isCommonWord(w)));
    const glued = new Set();
    for (const parts of names) {
      for (let i = 0; i < parts.length; i++) {
        for (let n = 2; n <= 3 && i + n <= parts.length; n++) {
          const g = parts.slice(i, i + n).join("");
          if (g.length >= 5) glued.add(g);
        }
      }
    }
    if (glued.size) {
      const sorted = [...glued].sort((a, b) => b.length - a.length);
      let re;
      try {
        re = new RegExp(`(?<![A-Za-z])(?:${sorted.map(escapeRe).join("|")})(?![A-Za-z])`, "gi");
      } catch {
        re = null;
      }
      if (re) {
        for (const m of text.matchAll(re)) push(m.index, m.index + m[0].length);
      }
    }
    return out;
  }

  /** Deterministic name cues: titles, greetings, sign-offs, relations, "Name:" labels. */
  _learnCues(text) {
    const CAP = "\\p{Lu}\\p{Ll}+";
    const NAME = `(${CAP}(?:[ \\t]+${CAP}){0,3})`;
    const cues = [
      { cue: "Mr./Ms./Dr. title", src: `\\b(?:Mr|Mrs|Ms|Miss|Dr|Shri|Smt|Sri|Prof)\\.?[ \\t]+${NAME}` },
      { cue: "Dear/Hi greeting", src: `\\b(?:Dear|Hi|Hello|Hey)[ \\t]+(?:(?:Mr|Mrs|Ms|Miss|Dr|Shri|Smt|Sri|Prof)\\.?[ \\t]+)?${NAME}` },
      { cue: "sign-off (Regards…)", src: `\\b(?:Regards|Thanks|Thank you|Sincerely|Best|Cheers|Yours (?:truly|sincerely|faithfully))[,!.]?[ \\t]*\\r?\\n?[ \\t]*${NAME}` },
      { cue: "Name:/Client: label", src: `\\b(?:Name|Client|Customer|Applicant|Nominee|Beneficiary|Holder|Guardian|Spouse|Wife|Husband|Father|Mother|Son|Daughter|Brother|Sister)(?:[ \\t]+name)?[ \\t]*[:\\-–][ \\t]*${NAME}` },
      { cue: "relation (spouse…)", src: `\\b(?:spouse|wife|husband|father|mother|son|daughter|brother|sister|nominee)[ \\t]+${NAME}` },
    ];
    for (const { cue, src } of cues) {
      for (const m of text.matchAll(new RegExp(src, "gu"))) {
        const words = [];
        for (const w of m[1].split(/\s+/)) {
          if (NOT_A_NAME.has(w.toLowerCase()) || TITLES.test(w)) break;
          words.push(w);
        }
        if (words.length) this._addTerm(words.join(" "), "NAME", { source: "cue", cue });
      }
    }
  }

  /**
   * Ask Needle about one chunk until it reports nothing new in TWO consecutive
   * runs. Needle is deterministic, so repeating an identical question would
   * only repeat the answer; consecutive runs therefore alternate between two
   * different phrasings of every question (variant 0 / 1), and whatever a run
   * finds is blanked out of the working text before the next run.
   */
  async _scanChunk(chunk) {
    let working = chunk;
    let empty = 0;
    for (let run = 0; run < MAX_RUNS && empty < this.emptyRunsToStop; run++) {
      const variant = run % 2;
      const hits = await this._askAll(working, variant);
      // Validate every answer against the SAME text (a longer address must not
      // lose to a name found inside it), then blank them all out together.
      const base = working;
      let added = 0;
      for (const { raw, kind, question } of hits) {
        const found = this._accept(raw, kind, base);
        if (!found) continue;
        // WHY first-wins in _addTerm: every later occurrence in the file
        // reports the run/phrasing that first surfaced the term.
        this._addTerm(found.term, found.kind, { source: "needle", question, run, variant });
        working = working.replace(new RegExp(wsRe(found.term), "gi"), "_");
        added++;
      }
      empty = added ? 0 : empty + 1;
    }
  }

  /** One run: every relevant question, once, all at the same time (the pool queues them). */
  async _askAll(text, variant) {
    const d = this.detector;
    const rest = applySpans(text, findPatternSpans(text, { dates: true }), () => " ").replace(/_/g, " ");
    // Capitalised words that are not just a sentence opener such as "The" or "Please".
    const capital = (rest.match(/\p{Lu}\p{L}{2,}/gu) || []).some((w) => !STARTERS.has(w.toLowerCase()));
    const want = {
      person: capital,
      address: ADDRESS_HINT.test(rest),
      // A digit-bearing token the patterns did not already claim.
      account: /\b[A-Za-z]*\d[\dA-Za-z/-]{3,}/.test(rest),
      secret: /(?:pass\w*|pwd|\bpw\b|\bpin\b|otp|cvv|cvc|login|user ?(?:name|id)|credential|secret)\W+\w{3,}/i.test(rest),
      pii: capital || /\d|@/.test(rest),
    };
    want.id = want.account;
    const KIND = { person: "NAME", address: "ADDRESS", account: "ACCOUNT", id: "ID", secret: "SECRET", pii: "PII" };
    const out = [];
    await Promise.all(
      Object.keys(KIND)
        .filter((q) => want[q])
        .map(async (q) => {
          try {
            const raw = await d.find(q, text, variant);
            if (raw) out.push({ raw, kind: KIND[q], question: q });
          } catch {
            /* one failed question must not lose the others */
          }
        }),
    );
    return out;
  }

  /**
   * Validate one answer. Returns { term, kind } (term is the exact text as it
   * appears in `working`, so find-and-replace works) or null to ignore it.
   * A hit running across table cells (tab/newline) is cut there first and
   * each piece judged on its own; the longest passing piece wins.
   */
  _accept(raw, kind, working) {
    if (/[\t\n]/.test(raw)) {
      const pieces = String(raw).split(/[\t\n]+/).map((s) => s.trim()).filter((s) => s.length > 1)
        .sort((a, b) => b.length - a.length);
      for (const p of pieces) {
        const r = this._acceptSingle(p, kind, working);
        if (r) return r;
      }
      return null;
    }
    return this._acceptSingle(raw, kind, working);
  }

  _acceptSingle(raw, kind, working) {
    let hit = cleanHit(raw);
    // Step-2 model-hit filter: generic labels, roles, short words, ISINs,
    // dates, amounts and uncued digit runs are never PII.
    if (isFilteredModelHit(hit, kind, working)) return null;
    // Amounts, currency values and company/ticker strings are never PII; the
    // 9+ digit carve-out keeps long digit strings eligible for the ID path.
    // WHY skip for plain digit runs: the step-2 filter above already decided
    // them by ID cue (a cued "Customer ID 12345678" must survive this check).
    const digitsOnlyRun = /^\d[\d\s]*$/.test(hit);
    if (!digitsOnlyRun && MONEY.test(hit) && !/^\d{9,}$/.test(hit.replace(/[\s,]/g, ""))) return null;
    if (CORPORATE.test(hit) || /^[A-Z]{1,5}$/.test(hit)) return null;
    if (kind === "PII") {
      kind = inferKind(hit);
      if (!kind) return null;
    }
    const isPerson = kind === "NAME";
    const isValue = kind === "ACCOUNT" || kind === "ID" || kind === "SECRET" ||
      kind === "PAN" || kind === "FOLIO" || kind === "PHONE" || kind === "EMAIL";
    // Statement labels and product-adjacent people are GLiNER false
    // positives; real names/addresses never match these narrow lists. Same
    // shared helper as _learnGliner so the older Needle path agrees with the
    // GLiNER path.
    if (kind === "NAME" || kind === "ADDRESS") {
      if (isGenericGlinerStop(hit)) return null;
    }
    if (kind === "NAME" && isFundAdjacent(hit, working)) return null;
    if (isValue) hit = cleanValue(raw);
    if (hit.length < 2 || hit.length > 140) return null;
    if (!isValue && /[:]/.test(hit)) return null;
    if (isValue) {
      if (kind === "EMAIL") {
        if (!/@/.test(hit) || hit.length < 5) return null;
      } else if (kind !== "SECRET" && (!/\d/.test(hit) || hit.length < 5)) return null;
      // WHY: ISINs (INF/INE + 9 chars) and price decimals (161.1706) are
      // broker-statement references, not accounts/IDs. Pattern-layer labelled
      // numbers (a/c, folio, demat…) bypass _accept, so they still hide.
      if (kind !== "SECRET" && kind !== "EMAIL" && /^(?:INE|INF)[0-9A-Z]{9}$/i.test(hit)) return null;
      if (kind !== "SECRET" && kind !== "EMAIL" && /\d+\.\d{4,}/.test(hit)) return null;
      // An account/ID is one compact token (or a few digit groups), never a phrase.
      // WHY EMAIL exempt: "rohan.mehta@example.com" has several letter groups.
      if (kind !== "SECRET" && kind !== "EMAIL" && (/,/.test(hit) || (hit.match(/\p{L}{3,}/gu) || []).length > 1)) return null;
      if (kind === "SECRET" && (hit.length < 4 || NOT_A_SECRET.test(hit))) return null;
      // A date that the user chose to keep is not an account number.
      if (findPatternSpans(hit, { dates: true }).some((sp) => sp.type === "DATE" && sp.end - sp.start === hit.length)) return null;
    }
    // Something a pattern already owns (a date, a phone number) is not a name.
    if (isPerson && findPatternSpans(hit, { dates: true }).length) return null;
    if (isPerson && /\d/.test(hit) && !ADDRESS_HINT.test(hit.replace(/[\d\s-]+/g, " ").trim().length > 2 ? hit : "")) return null;
    if (isPerson && !hit.includes(" ") && (NOT_A_NAME.has(hit.toLowerCase()) || (hit.length <= 5 && hit === hit.toUpperCase())))
      return null;
    // A lone capitalised word that merely opens a sentence ("Line one", "Table of
    // contents") is indistinguishable from an ordinary word; skip it. Full names
    // and mid-sentence names are unaffected.
    if (isPerson && !hit.includes(" ")) {
      const at = new RegExp(wsRe(hit), "i").exec(working);
      const opens = at && /(?:^|[.!?:]\s+|[\n(])$/.test(working.slice(0, at.index));
      if (opens && working.trim().split(/\s+/).length > 2) return null;
    }
    // Grounding: only text that really is in the input may be redacted, and the
    // stored term is the document's own spelling of it (the "exact quote").
    const m = new RegExp(wsRe(hit), "i").exec(working);
    if (!m || /\[[A-Z]+\]/.test(m[0])) return null;
    return { term: m[0], kind };
  }

  _addTerm(raw, kind, prov = null) {
    const term = raw.replace(/\s+/g, " ").trim();
    if (term.length < 2 || term.length > 140) return;
    const key = normKey(term);
    if (kind === "NAME" && !/\d/.test(term)) {
      if (prov && !this.termProv.has(key)) this.termProv.set(key, prov);
      else if (!prov && !this.termProv.has(key)) this.termProv.set(key, { source: "cue", cue: "name cue" });
      this.terms.NAME.add(term);
      const words = term.split(" ");
      const tokenizable = words.length <= 3 && !term.includes(",") && !CORPORATE.test(term);
      if (tokenizable) {
        for (const w of words) {
          if (/^\p{Lu}\p{L}{3,}$/u.test(w) && !TITLES.test(w)) {
            this.tokens.add(w);
            if (prov && !this.tokenProv.has(w)) this.tokenProv.set(w, prov);
            else if (!this.tokenProv.has(w)) this.tokenProv.set(w, this.termProv.get(key) || { source: "cue", cue: "name cue" });
          }
        }
      }
    } else {
      const bucket = kind === "NAME" ? "ADDRESS" : kind;
      if (prov && !this.termProv.has(key)) this.termProv.set(key, prov);
      else if (!prov && !this.termProv.has(key)) this.termProv.set(key, { source: "needle", question: bucket, run: 0, variant: 0 });
      this.terms[bucket].add(term);
    }
    this._compiled = null;
  }

  _compile() {
    const edge = (body, flags) =>
      new RegExp(`(?<![\\p{L}\\p{N}])(?:${body})(?![\\p{L}\\p{N}])`, flags);
    const build = (set, flags) => {
      if (!set.size) return null;
      const body = [...set].sort((a, b) => b.length - a.length).map(wsRe).join("|");
      return edge(body, flags);
    };
    // KINDS order matters. ADDRESS precedes NAME because the model sometimes
    // also reports a piece of an address (e.g. a locality) as a name, and the
    // longer address match must win.
    this._compiled = [
      ...KINDS.map((type) => ({ type, re: build(this.terms[type], "giu") })),
      { type: "NAME", re: build(this.tokens, "gu") },
    ].filter((c) => c.re);
  }

  _provForLearned(text) {
    const exact = this.tokenProv.get(text);
    if (exact) return exact;
    const p = this.termProv.get(normKey(text));
    if (p) return p;
    return { source: "needle", question: "find_pii", run: 0, variant: 0 };
  }

  _manualEntryFor(match) {
    const list = this.manual?.entries || [];
    const key = normKey(match);
    for (const e of list) if (normKey(e) === key) return e;
    // Fallback: case-insensitive containment (e.g. entry without boundaries).
    const low = match.toLowerCase();
    for (const e of list) if (low === e.toLowerCase()) return e;
    return match;
  }

  spans(text, opts = {}) {
    if (!text) return [];
    // WHY same-text learning: a labelled value and its bare repeat can sit in
    // one cell/paragraph, so learn from this text too (idempotent, file-wide).
    // WHY learned-set: _learnPatterns is pure overhead on repeats, so skip
    // texts already learned via learn() or an earlier spans() call.
    if (!this._learned.has(text)) {
      this._learnPatterns(text);
      this._learned.add(text);
    }
    // The user's own list wins over everything else.
    const manual = [];
    if (this.manual) {
      for (const m of text.matchAll(this.manual)) {
        manual.push({ start: m.index, end: m.index + m[0].length, type: "CUSTOM", source: "you", entry: this._manualEntryFor(m[0]) });
      }
    }
    const spans = findPatternSpans(text, { dates: this.dates }).filter(
      (sp) => !manual.some((m) => sp.start < m.end && sp.end > m.start),
    );
    spans.push(...manual);
    const taken = new Uint8Array(text.length);
    for (const s of spans) taken.fill(1, s.start, s.end);
    // WHY after patterns: propagated IDs never steal a labelled span, and the
    // taken map keeps them from overlapping each other.
    spans.push(...this._propSpans(text, taken));
    // Step-5 globals: batch-wide terms learned from the whole bundle.
    spans.push(...this._globalSpans(text, taken));
    // Step-6 trusted header values (+variants, surname widening) hide here as
    // well; the batch flow also adds them as globals for the other files.
    spans.push(...this._trustedSpans(text, taken));
    // Step-8 PIN, bank narrations, and (OCR text only) fuzzy OCR names.
    spans.push(...this._pinSpans(text, taken));
    spans.push(...this._narrationSpans(text, taken));
    if (opts.ocr) spans.push(...this._ocrSpans(text, taken));
    // Step-3 number guard: digits-only spans that read as amounts stay
    // visible. Ranges stay claimed (taken) so no learned term re-hides the
    // same digits; the user's own list ("you") and trusted values bypass it.
    for (let i = spans.length - 1; i >= 0; i--) {
      const s = spans[i];
      if (s.source === "you" || s.trusted) continue;
      if (isDigitsOnlyText(text.slice(s.start, s.end)) && isAmountVisible(text, s.start, s.end)) spans.splice(i, 1);
    }
    if (!this._compiled) this._compile();
    if (this._compiled.length) {
      for (const { type, re } of this._compiled) {
        for (const m of text.matchAll(re)) {
          const start = m.index;
          const end = start + m[0].length;
          let free = true;
          for (let i = start; i < end; i++) {
            if (taken[i]) {
              free = false;
              break;
            }
          }
          if (!free) continue;
          taken.fill(1, start, end);
          spans.push({ start, end, type, ...this._provForLearned(m[0]) });
        }
      }
    }
    // Step-4 security names: a no-digit learned span (model or cue) made only
    // of ISIN-line words stays visible. The user's own list still wins.
    if (this.securityWords.size) {
      for (let i = spans.length - 1; i >= 0; i--) {
        const s = spans[i];
        if (s.source !== "gliner" && s.source !== "needle" && s.source !== "cue") continue;
        if (this._isSecurityName(text.slice(s.start, s.end))) spans.splice(i, 1);
      }
    }
    spans.sort((a, b) => a.start - b.start);
    return spans;
  }

  _record(spans, text) {
    for (const s of spans) {
      this.counts[s.type] = (this.counts[s.type] || 0) + 1;
      // WHY slice from the input: the report must hold the exact original
      // quote, character-for-character (odd spacing/case included).
      const quote = text != null && s.start != null ? text.slice(s.start, s.end) : (s.quote ?? "");
      this.report.push({
        quote, type: s.type, source: s.source, rule: s.rule, cue: s.cue,
        question: s.question, run: s.run, variant: s.variant, label: s.label, score: s.score,
        entry: s.entry, header: s.header, trusted: s.trusted ?? null,
        start: s.start ?? null, end: s.end ?? null,
        location: s.location ?? "", page: s.page ?? "",
      });
    }
  }

  count(spans, text = null) {
    if (text == null) {
      for (const s of spans) this.counts[s.type] = (this.counts[s.type] || 0) + 1;
      return;
    }
    this._record(spans, text);
  }

  /** Redact `text`, tally what was hidden, return the new text. */
  apply(text) {
    if (!text) return text;
    const spans = this.spans(text);
    if (!spans.length) return text;
    // WHY count+record here (not in spans): spans() is also used for probing
    // (PDF render measurement, link targets), which must not double-report.
    this._record(spans, text);
    return applySpans(text, spans);
  }

  /** Hide a whole value (used for header-detected columns). */
  hideAs(type, text, header = null) {
    if (!text) return text;
    this.counts[type] = (this.counts[type] || 0) + 1;
    this.report.push({
      quote: text, type, source: "column", header,
      rule: null, cue: null, question: null, run: null, variant: null,
      entry: null, start: null, end: null, location: "", page: "",
    });
    return labelFor(type);
  }

  get total() {
    return Object.values(this.counts).reduce((a, b) => a + b, 0);
  }
}
