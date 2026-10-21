// Pattern layer: fixed-format identifiers found with regular expressions.
// Ported from the CRM's backend/utils/piiMasking.js and reworked to return
// character spans (start/end/type) instead of replaced strings, so the same
// detection can drive text replacement, DOCX run edits and PDF black boxes.
//
// Rules run in priority order; a later rule never overlaps a span an earlier
// rule already claimed (the more specific identifier wins).

const MONTHS =
  "Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?";

const digitCount = (s) => s.replace(/\D/g, "").length;

export const RULES = [
  { type: "EMAIL", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g },
  // UPI handle such as name@oksbi (no dot after the @, so EMAIL skips it).
  { type: "UPI", re: /\b[\w.-]{2,}@[a-z]{2,}\b/gi },
  { type: "GSTIN", re: /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g },
  { type: "PAN", re: /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g },
  // Bank IFSC: 4 letters, literal 0, 6 alphanumeric (e.g. HDFC0001234).
  { type: "IFSC", re: /\b[A-Z]{4}0[A-Z0-9]{6}\b/gi },
  { type: "IP", re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
  // 16-digit card, optionally grouped in 4s. Must precede SSN/AADHAAR/PHONE.
  { type: "CARD", re: /\b(?:\d{4}[ -]?){3}\d{4}\b/g },
  // US SSN 3-2-4. Must precede AADHAAR, which is looser.
  { type: "SSN", re: /\b\d{3}[ -]\d{2}[ -]\d{4}\b/g },
  { type: "AADHAAR", re: /\b(?:\d{4}[ -]?){2}\d{4}\b/g },
  // Long bank account numbers. Must precede PHONE, which would eat the first 15 digits.
  { type: "ACCOUNT", re: /\b\d{15,18}\b/g },
  // Dates (DOBs double as passwords on Form 16 / bank statements, so they are
  // PII). Toggleable because ordinary calendar dates are masked too.
  {
    type: "DATE",
    optional: "dates",
    re: new RegExp(
      [
        "\\b\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{4}\\b",
        "\\b\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}\\b",
        `\\b\\d{1,2}(?:st|nd|rd|th)?[ -](?:${MONTHS})\\.?,?[ -]\\d{2,4}\\b`,
        `\\b(?:${MONTHS})\\.? \\d{1,2}(?:st|nd|rd|th)?,? \\d{4}\\b`,
      ].join("|"),
      "gi",
    ),
  },
  // Loosest pattern: optional +country prefix, then 7-14 digits with spaces or
  // dashes between them. Runs last so it never pre-empts a specific match.
  { type: "PHONE", re: /(\+?\d[\d\s-]{6,13}\d)/g, accept: (m) => digitCount(m) >= 7 },
];

export function labelFor(type) {
  return `[${type}]`;
}

/**
 * @param {string} text
 * @param {{ dates?: boolean }} [opts]
 * @returns {{start:number,end:number,type:string}[]} non-overlapping, sorted
 */
export function findPatternSpans(text, { dates = true } = {}) {
  if (!text) return [];
  const taken = new Uint8Array(text.length);
  const spans = [];
  for (const rule of RULES) {
    // With dates off, the DATE rule still runs to claim its ranges (so the loose
    // PHONE pattern cannot swallow them) but emits no span.
    const silent = rule.optional === "dates" && !dates;
    rule.re.lastIndex = 0;
    for (const m of text.matchAll(rule.re)) {
      const start = m.index;
      const end = start + m[0].length;
      if (rule.accept && !rule.accept(m[0])) continue;
      let free = true;
      for (let i = start; i < end; i++) {
        if (taken[i]) {
          free = false;
          break;
        }
      }
      if (!free) continue;
      taken.fill(1, start, end);
      if (!silent) spans.push({ start, end, type: rule.type });
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

/** Replace spans (sorted, non-overlapping) with their [TYPE] labels, or with `label(span)`. */
export function applySpans(text, spans, label = (s) => labelFor(s.type)) {
  let out = "";
  let pos = 0;
  for (const s of spans) {
    out += text.slice(pos, s.start) + label(s);
    pos = s.end;
  }
  return out + text.slice(pos);
}
