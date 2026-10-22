// Statement-header layer (generic replacement for the casparser-style Python
// tool used on the benchmark). Indian consolidated account statements (CAMS /
// KFintech CAS, NSDL/CDSL CAS) and similar statements print an investor block
// near the top of page 1: the holder's name, address lines, Email, Mobile,
// PAN, then folios/accounts and nominee names. This module extracts those
// trusted values with layout regexes (no client-specific words). Trusted
// values skip the batch agreement check and are searched batch-wide, with
// name variants and surname widening (see redactor.js).
import { hasAddressWord, isCommonWord } from "./common-words.js";

const NAME_LABEL =
  /^\s*(?:name|investor(?:'s)?\s*name|client\s*name|applicant(?:'s)?\s*name|customer\s*name|sole\s*holder|first\s*holder|second\s*holder|third\s*holder|primary\s*holder|account\s*holder|holder(?:'s)?\s*name|joint\s*holder)\s*[:\-–]\s*(.+?)\s*$/i;
const NOMINEE_LABEL = /^\s*nominee(?:\(s\))?\s*[:\-–]\s*(.+?)\s*$/i;
const ADDRESS_LABEL =
  /^\s*(?:address|communication\s*address|permanent\s*address|correspondence\s*address|residence\s*address|mailing\s*address)\s*[:\-–]\s*(.+?)\s*$/i;
const EMAIL_LABEL = /^\s*(?:e-?mail(?:\s*(?:id|address))?|registered\s*e-?mail)\s*[:\-–]\s*(\S+)\s*$/i;
const MOBILE_LABEL =
  /^\s*(?:mobile|registered\s*mobile|phone|contact(?:\s*(?:no|number))?|mob|tel)\s*(?:no|number|num|#)?\s*[:\-–]\s*([+\d][\d\s\-]{6,})\s*$/i;
const PAN_LABEL = /^\s*(?:pan)\s*(?:no|number)?\s*[:\-–]\s*([A-Z]{5}[0-9]{4}[A-Z])\s*$/i;
const FOLIO_LABEL = /^\s*folio\s*(?:no|number|num)?\s*[:\-–]\s*(\S+)\s*$/i;
const CLIENT_LABEL =
  /^\s*(?:client|bo|dp|demat|crn|ucc|customer|member|policy|crn)\s*(?:id|no|number|num|code)?\s*[:\-–]\s*(\S+)\s*$/i;
// A line that ends the address continuation (next labelled field or section).
const STOP_LABEL =
  /^(?:pan|tan|gstin|mob|tel|phone|e-?mail|folio|client|dp|demat|nominee|nomination|date|dob|status|statement|period|summary|certificate|form|assessment|account|a\/c|pin)\b/i;
// Email / PAN shapes inside the block (also caught by the pattern layer, but
// here they become trusted).
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
const PAN_RE = /\b[A-Z]{5}[0-9]{4}[A-Z]\b/;

/** Clean a captured name: trim punctuation, require letter words, reject filler. */
function cleanName(raw) {
  const v = String(raw || "").trim().replace(/^[:\-–\s]+|[\s,;:.]+$/g, "").replace(/\s+/g, " ");
  if (!v) return "";
  const words = v.split(" ");
  if (words.length < 1 || words.length > 4) return "";
  if (words.some((w) => !/^[A-Za-z][A-Za-z.]*$/.test(w))) return "";
  if (!words.some((w) => w.replace(/\./g, "").length >= 2)) return "";
  if (words.length === 1 && isCommonWord(words[0])) return "";
  if (/^(?:self|spouse|child|children|nominee|holder)$/i.test(v)) return "";
  return v;
}

function cleanAddressLine(raw) {
  const v = String(raw || "").trim().replace(/\s+/g, " ");
  return v.length >= 4 ? v : "";
}

/**
 * Extract trusted investor-block values from one text fragment.
 * Returns [{value, type}] with types NAME/ADDRESS/EMAIL/PHONE/PAN/FOLIO/ID.
 */
export function extractHeader(text) {
  const out = [];
  const seen = new Set();
  const push = (value, type) => {
    const v = String(value || "").trim();
    if (!v || seen.has(`${type}:${v.toLowerCase()}`)) return;
    seen.add(`${type}:${v.toLowerCase()}`);
    out.push({ value: v, type });
  };
  const lines = String(text || "").split("\n");
  // Line indices holding a name/address: block region for co-located trust.
  const blockLines = new Set();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if ((m = line.match(NAME_LABEL)) || (m = line.match(NOMINEE_LABEL))) {
      const v = cleanName(m[1]);
      if (v) {
        push(v, "NAME");
        blockLines.add(i);
        // Address continuation: following address-ish lines until the next
        // labelled field (up to 4 lines).
        for (let j = i + 1; j < Math.min(lines.length, i + 5); j++) {
          const l2 = lines[j].trim();
          if (!l2 || STOP_LABEL.test(l2) || /:$/.test(l2)) break;
          if (/\d/.test(l2) || hasAddressWord(l2)) {
            const a = cleanAddressLine(l2);
            if (a) {
              push(a, "ADDRESS");
              blockLines.add(j);
            }
          } else break;
        }
      }
      continue;
    }
    if ((m = line.match(ADDRESS_LABEL))) {
      const v = cleanAddressLine(m[1]);
      if (v) {
        push(v, "ADDRESS");
        blockLines.add(i);
      }
      continue;
    }
    if ((m = line.match(EMAIL_LABEL))) {
      const em = (m[1].match(EMAIL_RE) || [])[0];
      if (em) push(em, "EMAIL");
      continue;
    }
    if ((m = line.match(MOBILE_LABEL))) {
      const digits = m[1].replace(/\D/g, "");
      if (digits.length >= 10 && digits.length <= 13) push(m[1].trim().replace(/\s+/g, " "), "PHONE");
      continue;
    }
    if ((m = line.match(PAN_LABEL))) {
      push(m[1], "PAN");
      continue;
    }
    if ((m = line.match(FOLIO_LABEL))) {
      const base = m[1].split("/")[0].trim();
      if (base.replace(/\D/g, "").length >= 5) push(base, "FOLIO");
      continue;
    }
    if ((m = line.match(CLIENT_LABEL))) {
      const v = m[1].trim().replace(/[,;:.]+$/, "");
      if (v.length >= 5 && /\d/.test(v)) push(v, "ID");
    }
  }
  // Email/PAN shapes co-located with a found name/address (same block, ±10
  // lines) also count as trusted. Support mailboxes elsewhere stay untouched
  // (step 9: nothing may hide support mailboxes).
  if (blockLines.size) {
    const lo = Math.max(0, Math.min(...blockLines) - 10);
    const hi = Math.max(...blockLines) + 10;
    const block = lines.slice(lo, hi + 1).join("\n");
    for (const em of block.match(new RegExp(EMAIL_RE.source, "g")) || []) push(em, "EMAIL");
    for (const pan of block.match(new RegExp(PAN_RE.source, "g")) || []) push(pan, "PAN");
  }
  return out;
}
