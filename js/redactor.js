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

// Needle is only reliable on short, sentence-sized input (measured), so text is
// split per sentence/line; only tiny neighbouring fragments are merged.
const CHUNK_MAX = 200;
const CHUNK_MERGE = 30;
// GLiNER scores one ~300-char window per call for person + address together.
// Thresholds: addresses at 0.25; two-word names at 0.2 (the capitalisation
// shape filter does the precision work); single-word names at 0.45.
const GLINER_WINDOW = 300;
const GLINER_MIN = 0.25;
const GLINER_MIN_NAME = 0.2;
const GLINER_MIN_SINGLE = 0.45;
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

const KINDS = ["ADDRESS", "ACCOUNT", "ID", "SECRET", "NAME", "PII"]; // match priority, highest first
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

/** Split what the user typed into items: commas and line breaks both separate. */
export function parseManual(text) {
  return String(text || "").split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
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
  if (src === "needle") {
    const q = s.question === "pii" ? "find_pii" : (s.question || "");
    return { found_by: "needle", detail: `${q}, run ${s.run ?? ""}, variant ${s.variant ?? ""}`.trim() };
  }
  return { found_by: "script", detail: s?.rule || s?.type || "" };
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
  constructor({ dates = true, detector = null, thorough = true, manual = [] } = {}) {
    this.dates = dates;
    this.manual = buildManual(manual);
    // Thorough: keep asking until nothing new turns up in two runs in a row. Quick: one.
    this.emptyRunsToStop = thorough ? EMPTY_RUNS_TO_STOP : 1;
    this.detector = detector;
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
  }

  /** Reset the per-file tally (terms learned in earlier files are kept out too). */
  resetFile() {
    this.counts = {};
    this.terms = newTerms();
    this.tokens = new Set();
    this.seen = new Set();
    this._compiled = null;
    this.report = [];
    this.termProv = new Map();
    this.tokenProv = new Map();
    this.propagated = new Map();
    this._propRe = null;
    this._propReSize = 0;
    this._learned = new Set();
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

  async learn(texts, { onProgress, maxChunks = Infinity, maxMs = Infinity } = {}) {
    for (const t of texts) {
      if (!t) continue;
      this._learnCues(t);
      this._learnPatterns(t);
      this._learned.add(t);
    }
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

  /** GLiNER pass. One call per ~300-char window asks for person + address together. */
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
    // A window with no capitalised word outside the statement vocabulary
    // cannot hold a name or address, so the model never needs to see it.
    const STATEMENT_WORDS = /^(?:Outstanding|Distributed|Forfeited|Accumulated|Unvested|Currently|Processing|Deposit|Starting|From|Name|Date|Description|Quantity|Amount|Cost|Basis|Gain|Loss|Sale|Sold|Purchase|Transaction|Holdings|Position|Market|Closing|Opening|Period|Company|Number|Summary|Future|Available|Remainder|After|Change|History|Currencies|Dollars|United|States|Specified|Unless|All)$/;
    const hasCandidate = (w) => (w.match(/\p{Lu}\p{L}{2,}/gu) || []).some((x) => !GLINER_NOT_PII.test(x) && !STATEMENT_WORDS.test(x));
    const list = [...wins.keys()].filter((w) => /\p{L}{3,}/u.test(w) && hasCandidate(w));
    const total = Math.min(list.length, maxChunks);
    const started = Date.now();
    let done = 0;
    let next = 0;
    const lane = async () => {
      while (next < total && Date.now() - started < maxMs) {
        const w = list[next++];
        for (const e of await this.detector.recognize(w, GLINER_MIN)) {
          const kind = e.label === "person" ? "NAME" : e.label === "address" ? "ADDRESS" : null;
          if (!kind || e.score < (kind === "NAME" ? (e.word.trim().includes(" ") ? GLINER_MIN_NAME : GLINER_MIN_SINGLE) : GLINER_MIN)) continue;
          const raw = e.word.replace(/\s+/g, " ").trim();
          if (GLINER_NOT_PII.test(raw) || /^(?:RB|C)?[0-9A-F]{6,}$/i.test(raw) || !/\p{L}{3,}/u.test(raw)) continue;
          if (kind === "NAME" && !raw.split(" ").every((x) => /^\p{Lu}[\p{L}'.-]*$/u.test(x))) continue;
          // WHY shared helper here as well as in _accept: the GLiNER window is
          // available at this point, so product names skip before grounding;
          // _accept repeats the check on its working text for the older path.
          if (kind === "NAME" && isFundAdjacent(raw, w)) continue;
          const found = this._accept(raw, kind, w.replace(/\n/g, " "));
          if (found) this._addTerm(found.term, found.kind, { source: "gliner", label: e.label, score: +e.score.toFixed(2) });
        }
        onProgress?.(++done, total);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(this.detector.size || 1, total)) }, lane));
    return { scanned: done, total: list.length, truncated: done < list.length };
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
   */
  _accept(raw, kind, working) {
    let hit = cleanHit(raw);
    // Amounts, currency values and company/ticker strings are never PII; the
    // 9+ digit carve-out keeps long digit strings eligible for the ID path.
    if (MONEY.test(hit) && !/^\d{9,}$/.test(hit.replace(/[\s,]/g, ""))) return null;
    if (CORPORATE.test(hit) || /^[A-Z]{1,5}$/.test(hit)) return null;
    if (kind === "PII") {
      kind = inferKind(hit);
      if (!kind) return null;
    }
    const isPerson = kind === "NAME";
    const isValue = kind === "ACCOUNT" || kind === "ID" || kind === "SECRET";
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
      if (kind !== "SECRET" && (!/\d/.test(hit) || hit.length < 5)) return null;
      // WHY: ISINs (INF/INE + 9 chars) and price decimals (161.1706) are
      // broker-statement references, not accounts/IDs. Pattern-layer labelled
      // numbers (a/c, folio, demat…) bypass _accept, so they still hide.
      if ((kind === "ACCOUNT" || kind === "ID") && /^(?:INE|INF)[0-9A-Z]{9}$/i.test(hit)) return null;
      if ((kind === "ACCOUNT" || kind === "ID") && /\d+\.\d{4,}/.test(hit)) return null;
      // An account/ID is one compact token (or a few digit groups), never a phrase.
      if (kind !== "SECRET" && (/,/.test(hit) || (hit.match(/\p{L}{3,}/gu) || []).length > 1)) return null;
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

  spans(text) {
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
        question: s.question, run: s.run, variant: s.variant,
        entry: s.entry, header: s.header, start: s.start ?? null, end: s.end ?? null,
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
