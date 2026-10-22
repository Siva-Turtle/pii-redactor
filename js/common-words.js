// Small generic word lists shared by the batch-wide rules (address parts,
// family names, OCR/narration names). WHY one module: the same "not a real
// name/place" judgement is needed in several layers, and the lists must stay
// generic (no client-specific words). All matching is case-insensitive.
const SALUTATIONS = [
  "name", "dear", "hello", "hi", "respected", "sir", "madam", "mr", "mrs", "ms",
  "miss", "shri", "smt", "kumari", "dr", "master", "baby", "late",
];
const STOP_WORDS = ["to", "from", "by", "for", "of", "the", "and"];
const ROLE_WORDS = [
  "customer", "client", "investor", "holder", "nominee", "applicant", "insured",
  "proposer", "account", "accounts", "primary", "joint",
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
  [...SALUTATIONS, ...STOP_WORDS, ...ROLE_WORDS, ...PLACE_WORDS].map((w) => w.toLowerCase().replace(/[^a-z]/g, "")),
);

/** True when the word is a generic salutation/stop/role/place word (case-insensitive). */
export function isCommonWord(w) {
  return COMMON_WORDS.has(String(w || "").toLowerCase().replace(/[^a-z]/g, ""));
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
