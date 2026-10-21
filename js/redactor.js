// Combines the two redaction layers behind one small API:
//
//   const r = new Redactor({ dates: true, detector });   // detector optional (Needle)
//   await r.learn(allTextsInTheFile, onProgress);        // AI pass: discover names/addresses
//   r.spans(text)  -> [{start,end,type}]                 // where PII sits in `text`
//   r.apply(text)  -> "…[NAME]…"                         // replaced text (also counts it)
//
// Layer 1 (patterns.js) finds fixed-format identifiers. Layer 2 (Needle, via
// `detector`) discovers names and addresses; each one found is then redacted
// EVERYWHERE it occurs in the file, not only in the chunk that revealed it.

import { applySpans, findPatternSpans, labelFor } from "./patterns.js";

// Needle is only reliable on short, sentence-sized input (measured), so text is
// split per sentence/line; only tiny neighbouring fragments are merged.
const CHUNK_MAX = 200;
const CHUNK_MERGE = 30;
const MAX_NAMES_PER_CHUNK = 4;
const TITLES = /^(?:mr|mrs|ms|miss|dr|shri|smt|sri|prof|mx)$/i;
const CORPORATE = /\b(?:pvt|ltd|limited|bank|inc|llc|llp|corp|wealth|capital|finance|fund|trust|services|technologies|solutions|group|company|co|insurance|securities|partners)\b/i;
const ADDRESS_HINT =
  /\d|\b(?:road|rd|street|st|lane|nagar|colony|apartments?|flat|floor|sector|avenue|ave|blvd|marg|society|plot|block|tower|residency|layout|cross|main)\b/i;

// Capitalised words the model sometimes reports on their own; never a name.
const NOT_A_NAME = new Set(
  ("dear hi hello hey regards thanks thank sincerely yours please registered client customer account address " +
    "contact mobile phone email name sir madam team office branch bank date amount total note notes subject " +
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

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wsRe = (s) => escapeRe(s).replace(/\s+/g, "\\s+");

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

export class Redactor {
  constructor({ dates = true, detector = null } = {}) {
    this.dates = dates;
    this.detector = detector;
    this.terms = { NAME: new Set(), ADDRESS: new Set() };
    this.tokens = new Set(); // single first/last names, matched case-sensitively
    this.counts = {};
    this.seen = new Set();
    this._compiled = null;
  }

  /** Reset the per-file tally (terms learned in earlier files are kept out too). */
  resetFile() {
    this.counts = {};
    this.terms = { NAME: new Set(), ADDRESS: new Set() };
    this.tokens = new Set();
    this.seen = new Set();
    this._compiled = null;
  }

  /**
   * AI pass. `texts` is every text fragment of the file. Returns how many
   * chunks were scanned and whether the budget cut the scan short.
   */
  async learn(texts, { onProgress, maxChunks = Infinity } = {}) {
    for (const t of texts) if (t) this._learnCues(t);
    if (!this.detector) return { scanned: 0, total: 0, truncated: false };
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
    for (let i = 0; i < total; i++) {
      await this._scanChunk(list[i]);
      onProgress?.(i + 1, total);
    }
    return { scanned: total, total: list.length, truncated: list.length > total };
  }

  /** Deterministic name cues: titles, greetings, sign-offs, relations, "Name:" labels. */
  _learnCues(text) {
    const CAP = "\\p{Lu}\\p{Ll}+";
    const NAME = `(${CAP}(?:[ \\t]+${CAP}){0,3})`;
    const cues = [
      `\\b(?:Mr|Mrs|Ms|Miss|Dr|Shri|Smt|Sri|Prof)\\.?[ \\t]+${NAME}`,
      `\\b(?:Dear|Hi|Hello|Hey)[ \\t]+(?:(?:Mr|Mrs|Ms|Miss|Dr|Shri|Smt|Sri|Prof)\\.?[ \\t]+)?${NAME}`,
      `\\b(?:Regards|Thanks|Thank you|Sincerely|Best|Cheers|Yours (?:truly|sincerely|faithfully))[,!.]?[ \\t]*\\r?\\n?[ \\t]*${NAME}`,
      `\\b(?:Name|Client|Customer|Applicant|Nominee|Beneficiary|Holder|Guardian|Spouse|Wife|Husband|Father|Mother|Son|Daughter|Brother|Sister)(?:[ \\t]+name)?[ \\t]*[:\\-–][ \\t]*${NAME}`,
      `\\b(?:spouse|wife|husband|father|mother|son|daughter|brother|sister|nominee)[ \\t]+${NAME}`,
    ];
    for (const src of cues) {
      for (const m of text.matchAll(new RegExp(src, "gu"))) {
        const words = [];
        for (const w of m[1].split(/\s+/)) {
          if (NOT_A_NAME.has(w.toLowerCase()) || TITLES.test(w)) break;
          words.push(w);
        }
        if (words.length) this._addTerm(words.join(" "), true);
      }
    }
  }

  async _scanChunk(chunk) {
    const rest = applySpans(chunk, findPatternSpans(chunk, { dates: true }), () => " ");
    const wantPerson = /\p{Lu}\p{L}{2,}/u.test(rest);
    const wantAddress = ADDRESS_HINT.test(rest);
    await Promise.all([
      wantPerson ? this._loop(chunk, (t) => this.detector.findPerson(t), MAX_NAMES_PER_CHUNK, true) : null,
      wantAddress ? this._loop(chunk, (t) => this.detector.findAddress(t), 2, false) : null,
    ]);
  }

  async _loop(chunk, find, max, isPerson) {
    let working = chunk;
    for (let i = 0; i < max; i++) {
      let hit;
      try {
        hit = await find(working);
      } catch {
        return;
      }
      if (!hit) return;
      hit = cleanHit(hit);
      if (hit.length < 2 || /[:]/.test(hit)) return;
      // Something a pattern already owns (a date, a phone number) is not a name.
      if (isPerson && findPatternSpans(hit, { dates: true }).length) return;
      if (isPerson && /\d/.test(hit) && !ADDRESS_HINT.test(hit.replace(/[\d\s-]+/g, " ").trim().length > 2 ? hit : "")) return;
      if (isPerson && !hit.includes(" ") && (NOT_A_NAME.has(hit.toLowerCase()) || (hit.length <= 5 && hit === hit.toUpperCase())))
        return;
      const re = new RegExp(wsRe(hit), "i");
      // Grounding check: only text that really is in the input may be redacted.
      if (!re.test(working) || /\[[A-Z]+\]/.test(hit)) return;
      this._addTerm(hit, isPerson);
      working = working.replace(new RegExp(wsRe(hit), "gi"), "_");
    }
  }

  _addTerm(raw, isPerson) {
    const term = raw.replace(/\s+/g, " ").trim();
    if (term.length < 2 || term.length > 140) return;
    const asAddress = !isPerson || /\d/.test(term);
    if (asAddress) {
      this.terms.ADDRESS.add(term);
    } else {
      this.terms.NAME.add(term);
      const words = term.split(" ");
      const tokenizable = words.length <= 3 && !term.includes(",") && !CORPORATE.test(term);
      if (tokenizable) {
        for (const w of words) {
          if (/^\p{Lu}\p{L}{3,}$/u.test(w) && !TITLES.test(w)) this.tokens.add(w);
        }
      }
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
    this._compiled = [
      // ADDRESS first: the model sometimes also reports a piece of an address
      // (e.g. a locality) as a name, and the longer address match must win.
      { type: "ADDRESS", re: build(this.terms.ADDRESS, "giu") },
      { type: "NAME", re: build(this.terms.NAME, "giu") },
      { type: "NAME", re: build(this.tokens, "gu") },
    ].filter((c) => c.re);
  }

  spans(text) {
    if (!text) return [];
    const spans = findPatternSpans(text, { dates: this.dates });
    if (!this._compiled) this._compile();
    if (this._compiled.length) {
      const taken = new Uint8Array(text.length);
      for (const s of spans) taken.fill(1, s.start, s.end);
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
          spans.push({ start, end, type });
        }
      }
      spans.sort((a, b) => a.start - b.start);
    }
    return spans;
  }

  count(spans) {
    for (const s of spans) this.counts[s.type] = (this.counts[s.type] || 0) + 1;
  }

  /** Redact `text`, tally what was hidden, return the new text. */
  apply(text) {
    if (!text) return text;
    const spans = this.spans(text);
    if (!spans.length) return text;
    this.count(spans);
    return applySpans(text, spans);
  }

  /** Hide a whole value (used for header-detected columns). */
  hideAs(type, text) {
    if (!text) return text;
    this.counts[type] = (this.counts[type] || 0) + 1;
    return labelFor(type);
  }

  get total() {
    return Object.values(this.counts).reduce((a, b) => a + b, 0);
  }
}
