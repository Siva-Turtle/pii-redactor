// Small generic word lists shared by the batch-wide rules (address parts,
// family names, OCR/narration names). WHY one module: the same "not a real
// name/place" judgement is needed in several layers, and the lists must stay
// generic (no client-specific words). All matching is case-insensitive.
const SALUTATIONS = [
  "name", "dear", "hello", "hi", "respected", "sir", "madam", "mr", "mrs", "ms",
  "miss", "shri", "smt", "kumari", "dr", "master", "baby", "late",
];
const STOP_WORDS = [
  "to", "from", "by", "for", "of", "the", "and", "in", "on", "at", "as", "is",
  "an", "up", "a", "are", "was", "were", "be", "been", "with", "not", "no",
  "or", "it", "its", "this", "that", "these", "those", "then", "than", "so",
  "such", "any", "all", "each", "every", "either", "both", "few", "more",
  "most", "other", "some", "only", "own", "same", "too", "very", "can",
  "will", "just", "should", "now",
];
const ROLE_WORDS = [
  "customer", "client", "investor", "holder", "nominee", "applicant", "insured",
  "proposer", "account", "accounts", "primary", "joint",
];
// Generic statement/prose words that are never a person name on their own.
// WHY generic only: no client-specific words; all match case-insensitively.
// Currency codes sit here too: "INR" is a unit, never a name, so every
// generic gate (learned terms, globals, trusted values) rejects it.
const GENERIC_WORDS = [
  "details", "detail", "registered", "recipient", "recipients", "information",
  "asset", "assets", "investment", "investments", "forward", "indian",
  "investors", "customers", "clients", "holders", "nominees", "applicants",
  "regards", "thanks", "thank", "sincerely", "yours", "please",
  "team", "office", "branch", "bank", "banks", "date", "dates",
  "amount", "amounts", "total", "totals", "note", "notes",
  "statement", "statements", "self", "spouse",
  "number", "numbers", "address", "addresses",
  "holding", "holdings", "right", "rights",
  "non", "promoter", "promoters", "within",
  "inr", "usd", "aed", "eur", "gbp", "sgd", "cad", "aud", "rs",
];
// Country / state / major-city names (public geography, never PII).
const PLACE_WORDS = [
  "india", "bharat",
  "maharashtra", "gujarat", "karnataka", "tamil nadu", "tamilnadu", "kerala",
  "punjab", "haryana", "rajasthan", "madhya pradesh", "uttar pradesh", "bihar",
  "west bengal", "odisha", "orissa", "assam", "telangana", "andhra pradesh",
  "goa", "delhi", "mumbai", "bombay", "bengaluru", "bangalore", "chennai",
  "madras", "kolkata", "calcutta", "pune", "poona", "hyderabad", "ahmedabad",
  "jaipur", "surat", "lucknow", "kanpur", "nagpur", "indore", "thane",
  "bhopal", "visakhapatnam", "patna", "vadodara", "ghaziabad", "ludhiana",
  "agra", "nashik", "faridabad", "meerut", "rajkot", "varanasi", "srinagar",
  "aurangabad", "dhanbad", "amritsar", "allahabad", "prayagraj", "ranchi",
  "howrah", "coimbatore", "jabalpur", "gwalior", "vijayawada", "jodhpur",
  "madurai", "raipur", "kota", "kochi", "cochin", "thiruvananthapuram",
  "trivandrum", "bhubaneswar", "solapur", "mysore", "mysuru", "mangalore",
  "noida", "gurgaon", "gurugram", "chandigarh", "dehradun", "shimla", "udaipur",
  "uae", "united arab emirates", "dubai", "abu dhabi", "abudhabi", "sharjah",
  "ajman", "fujairah", "ras al khaimah", "umm al quwain",
  "singapore", "uk", "united kingdom", "london", "usa", "united states",
  "america", "new york", "california", "texas",
];
export const COMMON_WORDS = new Set(
  [...SALUTATIONS, ...STOP_WORDS, ...ROLE_WORDS, ...GENERIC_WORDS, ...PLACE_WORDS].map((w) => w.toLowerCase().replace(/[^a-z]/g, "")),
);

/** True when the word is a generic salutation/stop/role/place word (case-insensitive). */
export function isCommonWord(w) {
  return COMMON_WORDS.has(String(w || "").toLowerCase().replace(/[^a-z]/g, ""));
}

/**
 * Shared gate for every path that LEARNS a name (cues, labels, headers,
 * model hits, batch globals). True = reject this candidate, never learn it.
 * WHY one gate: a bad term learned once redacts everywhere via file-local
 * terms and batch globals, so every entry point must agree.
 * Rules (generic, no document-specific words):
 * - single-token names need >= 3 letters ("An"/"Up" are never names);
 * - all-lowercase candidates are prose (real names are Capitalised/UPPERCASE);
 * - every token being a stop/function or common/generic word is a label,
 *   not a person ("For", "Investor", "Registered", "Not Registered").
 */
export function isGenericNameTerm(term) {
  const raw = String(term || "").trim();
  if (!raw) return true;
  const words = raw
    .split(/[\s\-–—]+/)
    .map((w) => w.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, ""))
    .filter(Boolean);
  if (!words.length) return true;
  if (words.length === 1 && words[0].replace(/[^A-Za-z]/g, "").length < 3) return true;
  if (!/[A-Z]/.test(raw)) return true;
  const isCommonToken = (w) => {
    const n = String(w || "").toLowerCase().replace(/[^a-z]/g, "");
    if (!n) return true;
    if (isCommonWord(n)) return true;
    if (n.length > 3 && n.endsWith("s") && isCommonWord(n.slice(0, -1))) return true;
    return false;
  };
  if (words.every(isCommonToken)) return true;
  return false;
}

/**
 * Short capitalised line with no digits that sits inside an address block,
 * e.g. a locality with a directional ("Malad (W)"). Generic shape only:
 * 1-4 words, letters/spaces/dots/hyphens/parens, starts with a capital,
 * at least one word with 3+ letters. Callers decide whether to hide it
 * (non-common) or skip over it (pure place words like "Mumbai").
 */
export function looksLikeLocalityLine(line) {
  const t = String(line || "").trim();
  if (!t || t.length < 3 || t.length > 40) return false;
  if (/\d/.test(t) || /[@/\t]/.test(t)) return false;
  if (/:$/.test(t)) return false;
  if (!/^[A-Z]/.test(t)) return false;
  if (!/^[A-Za-z][A-Za-z\s.\-()]*$/.test(t)) return false;
  const words = t.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 4) return false;
  if (!words.some((w) => w.replace(/[^A-Za-z]/g, "").length >= 3)) return false;
  return true;
}
// Address vocabulary shared by the step-5 address-parts rule, the step-6
// header continuation and the step-8 address-block rule (generic words only).
export const ADDRESS_WORDS = [
  "plot", "flat", "apt", "apartment", "soc", "society", "hsg", "nagar", "road", "rd",
  "street", "floor", "flr", "building", "bldg", "tower", "house", "lane", "sector",
  "box", "premise", "villa", "colony", "marg", "chowk", "wadi", "wing", "block",
  "pin", "pincode", "near", "opp", "st", "no",
];
const wordReLocal = (w) => new RegExp(`(?<![A-Za-z])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z])`, "i");
const ADDRESS_WORD_RES = ADDRESS_WORDS.map(wordReLocal);
/** True when `text` holds an address word (plot/flat/road/…) as a whole word. */
export function hasAddressWord(text) {
  return ADDRESS_WORD_RES.some((re) => re.test(String(text || "")));
}
