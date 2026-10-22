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

// WHY shared: a 15-18 digit number after ref/reference/txn/... is an order/
// transaction reference, not a bank account. Checked with only the 20 chars
// before the match so labelled "account no ..." numbers still hide.
const REF_CUE = /(?:reference|transaction|ws\s+ref|ref|txn|order|trade|cams)\b/i;
function isRefCued(text, start) {
  return REF_CUE.test(text.slice(Math.max(0, start - 20), start));
}

// A number/ID value that follows a label, e.g. "a/c 5010 0234 5678", "folio no 1234567/89".
// Hyphenated alphanumeric ids such as MS-A06F5B-E7 are one value, not separate groups.
const VALUE = "((?:[A-Z]{1,4}-[A-Z0-9-]*\\d[A-Z0-9-]*|[A-Z]{0,4}\\d[A-Z0-9/-]*)(?:[ ]\\d[A-Z0-9/-]*){0,3})";
const SEP = "(?:[ \\t]*(?:no\\.?|number|num|id|#))?[ \\t]*[:=\\-\u2013]?[ \\t]*(?:is|was)?[ \\t]*";
const labelled = (labels) => new RegExp(`\\b(?:${labels})${SEP}${VALUE}`, "gid");
const hasEnoughDigits = (m) => m.replace(/\D/g, "").length >= 5;
export const NOT_A_SECRET = /^(?:protected|required|reset|policy|will|has|to|for|the|and|is|was|not|only|code|number|sent|received|expired)$/i;

export const RULES = [
  { type: "EMAIL", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g },
  // UPI handle such as name@oksbi (no dot after the @, so EMAIL skips it).
  { type: "UPI", re: /\b[\w.-]{2,}@[a-z]{2,}\b/gi },
  // Passwords, PINs, OTPs, CVVs: the value after the word. DOBs are often used
  // as passwords ("pwd: 02-04-1987"), so this runs before DATE.
  {
    type: "SECRET",
    group: 1,
    re: /\b(?:password|passwd|pwd|pw|passcode|pin|otp|cvv2?|cvc)\b(?!\s+code)[ \t]*(?:is|was|:|=|-|\u2013)?[ \t]*(?:is)?[ \t]*([^\s,;]{3,40}?)(?=[.,;]?(?:\s|$))/gid,
    accept: (m) => !NOT_A_SECRET.test(m),
  },
  { type: "GSTIN", re: /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g },
  { type: "PAN", re: /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g },
  { type: "TAN", re: /\b[A-Z]{4}[0-9]{5}[A-Z]\b/g },
  // Bank IFSC: 4 letters, literal 0, 6 alphanumeric (e.g. HDFC0001234).
  { type: "IFSC", re: /\b[A-Z]{4}0[A-Z0-9]{6}\b/gi },
  // WHY silent guard: ISINs (INE/INF + 9 alphanumerics, 12 chars) are public
  // security codes, not accounts. Claims the range so no later rule hides it.
  // Placed before DEMAT/ACCOUNT; the real demat (IN + 6 digits + 8 digits,
  // third char a digit) never matches INE/INF so it still hides.
  { type: "ISIN", silent: true, re: /\b(?:INE|INF)[0-9A-Z]{9}\b/g },
  // NSDL demat (BO) ID: "IN" + 6-digit DP ID + 8-digit client ID, e.g. IN300123 10234567.
  { type: "DEMAT", re: /\bIN\d{6}[ -]?\d{8}\b/g },
  { type: "IP", re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
  // Labelled numbers. The label decides the type; only the value is hidden.
  { type: "AADHAAR", group: 1, re: labelled("aadhaar|aadhar|uidai|uid"), accept: (m) => digitCount(m) >= 12 },
  { type: "SSN", group: 1, re: labelled("ssn|social security(?: number)?"), accept: (m) => digitCount(m) >= 9 },
  { type: "CARD", group: 1, re: labelled("(?:credit |debit )?card"), accept: (m) => digitCount(m) >= 13 },
  { type: "DEMAT", group: 1, re: labelled("demat(?: a\\/c| account)?|bo[ -]?id|dp[ -]?id|client[ -]?id|beneficiary(?: owner)? id|nsdl[ -]?id|nsdl"), accept: hasEnoughDigits },
  { type: "FOLIO", group: 1, re: labelled("folio"), accept: hasEnoughDigits },
  { type: "POLICY", group: 1, re: labelled("policy|pran|uan|ckyc|nps"), accept: hasEnoughDigits },
  {
    type: "ID",
    group: 1,
    re: labelled("passport|voter(?: id)?|epic|driving licen[cs]e|itin|ein|gstin|pan|tan"),
    accept: hasEnoughDigits,
  },
  {
    type: "ACCOUNT",
    group: 1,
    re: labelled(
      "a\\/c|acct|account|savings|current account|salary account|loan(?: account)?|customer id|cif|cheque|micr|routing|aba|sort code|utr",
    ),
    // WHY the second clause: alphanumeric ids such as MS-A06F5B-E7 carry few
    // digits but are still account references when labelled.
    accept: (m) => hasEnoughDigits(m) || (m.length >= 6 && /\d/.test(m) && /[A-Z]/i.test(m)),
  },
  // WHY silent guards: broker/depository reference codes are not accounts.
  // Transaction tokens (EP-DR…, Txn…, CtBo…, Acpt…) and 15-18 digit numbers
  // cued within 20 chars by ref/reference/txn/… stay readable. They claim
  // their ranges so CARD/ACCOUNT below skip them. Placed after the labelled
  // rules so labelled numbers (a/c, folio, demat…) still hide.
  { type: "TXN", silent: true, re: /\b(?:EP-DR|Txn|CtBo|Acpt)[-A-Za-z0-9]*\b/g },
  // WHY group 1: only the digits are claimed; the cue word stays free.
  { type: "TXNREF", silent: true, group: 1, re: /\b(?:reference|transaction|ws\s+ref|ref|txn|order|trade|cams)[\s\S]{0,20}?(\d{15,18})\b/gid },
  // 16-digit card, optionally grouped in 4s; AMEX is 15 (4-6-5). Must precede SSN/AADHAAR/PHONE.
  { type: "CARD", re: /\b(?:\d{4}[ -]?){3}\d{4}\b/g },
  { type: "CARD", re: /\b3[47]\d{2}[ -]?\d{6}[ -]?\d{5}\b/g },
  // US SSN 3-2-4. Must precede AADHAAR, which is looser.
  { type: "SSN", re: /\b\d{3}[ -]\d{2}[ -]\d{4}\b/g },
  // Voter ID (EPIC): 3 letters + 7 digits.
  { type: "ID", re: /\b[A-Z]{3}\d{7}\b/g },
  { type: "AADHAAR", re: /\b(?:\d{4}[ -]?){2}\d{4}\b/g },
  // Long bank account numbers with no label. Must precede PHONE, which would eat the first 15 digits.
  // WHY accept: skip 15-18 digit numbers cued as order/transaction references
  // (guard above already claims most, this covers any ordering edge).
  { type: "ACCOUNT", re: /\b\d{15,18}\b/g, accept: (m, text, start) => !isRefCued(text, start) },
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
  // Tight phone rules: labelled numbers, 10-digit / US-style / Indian-mobile
  // with digit/punctuation guards, and +countrycode. The old loose rule (any
  // 7-14 digits with spaces/dashes) hid quantities and amounts in statement
  // tables (561 false hits on one 27-page file, 0 real), so it is gone.
  { type: "PHONE", group: 1, re: labelled("phone|mobile|mob|tel|telephone|contact|whatsapp|cell|fax"), accept: (m) => digitCount(m) >= 7 },
  { type: "PHONE", re: /(?<![\d.,])(?:\+\d{1,3}[ \t-]?)?(?:\(?\d{3}\)?[ \t-]\d{3}[ \t-]\d{4}|[6-9]\d{4}[ \t-]?\d{5}|\d{10})(?![\d]|[.,]\d)/g, accept: (m) => digitCount(m) >= 10 },
  { type: "PHONE", re: /(?<![\d.,])\+\d{1,3}[ \t-]?\d[\d \t-]{6,12}\d(?![\d]|[.,]\d)/g, accept: (m) => digitCount(m) >= 8 },
];

export function labelFor(type) {
  return type === "CUSTOM" ? "[REDACTED]" : `[${type}]`;
}

/**
 * @param {string} text
 * @param {{ dates?: boolean }} [opts]
 * @returns {{start:number,end:number,type:string,source:string,rule:string}[]} non-overlapping, sorted
 */
export function findPatternSpans(text, { dates = true } = {}) {
  if (!text) return [];
  const taken = new Uint8Array(text.length);
  const spans = [];
  for (const rule of RULES) {
    // With dates off, the DATE rule still runs to claim its ranges (so the loose
    // PHONE pattern cannot swallow them) but emits no span. Rules with
    // silent:true always claim without emitting (ISIN / transaction refs).
    const silent = rule.silent || (rule.optional === "dates" && !dates);
    rule.re.lastIndex = 0;
    for (const m of text.matchAll(rule.re)) {
      const [start, end] = rule.group ? m.indices[rule.group] : [m.index, m.index + m[0].length];
      // WHY extra args: the ACCOUNT guard needs the 20 chars before the match.
      if (rule.accept && !rule.accept(text.slice(start, end), text, start)) continue;
      let free = true;
      for (let i = start; i < end; i++) {
        if (taken[i]) {
          free = false;
          break;
        }
      }
      if (!free) continue;
      taken.fill(1, start, end);
      // WHY provenance on every span: the redaction report must say which
      // layer hid each quote. Pattern hits are always source "script".
      if (!silent) spans.push({ start, end, type: rule.type, source: "script", rule: rule.type });
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
