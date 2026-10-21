// Needle layer: runs Cactus Needle 3 (a ~35 MB function-calling model) locally
// in the browser via WebAssembly to find what regexes cannot: names, postal
// addresses, and finance identifiers written in unusual ways (account, demat,
// folio and policy numbers, government IDs, passwords/PINs/OTPs).
//
// Needle is a tool-calling model, not a dedicated NER model, so each question
// is asked with exactly ONE tool ("find_person", "find_address", ...). The model
// reports what it finds as the tool argument. Measured behaviour (see README):
//   * one tool per call is far more reliable than several tools at once
//   * it reports at most one entity per call, so callers loop until it says none
//   * `stateless` is required, otherwise earlier text bleeds into later answers
//   * a company/organisation tool performed poorly, so it is not used
// Every answer is checked against the input text and dropped if it is not a
// verbatim substring, so the model can never invent text to redact.

import { createNeedle, tool } from "../vendor/needle/needle-browser.js";

const MODEL_SHA256 = "c9d915eca282ed42d1a09b143b592adb4cc6744ffe2d294adf5cfc5548170c38";
const asUrl = (rel) => new URL(rel, import.meta.url).href;

// Each question is its own single-tool definition, passed per call. One tool
// at a time is what keeps Needle reliable (see the notes above).
function question(name, description, argName) {
  return {
    [name]: tool({
      description,
      inputSchema: { type: "object", properties: { [argName]: { type: "string" } }, required: [argName] },
    }),
  };
}
// WORDING MATTERS: Needle is brittle about tool descriptions. Shortening these
// for speed made it stop finding a plain-word password, so they are kept exactly
// as validated against test/fixtures/finance.txt. Re-run that test if you edit one.
// Two phrasings (variant 0 / 1) of every question. Needle is deterministic, so
// the redactor alternates phrasings between consecutive runs: "nothing found
// twice in a row" then means two *different* questions both came back empty.
const QUESTIONS = {
  person: [
    question("find_person", "Find the full name of a person mentioned in the text.", "person_name"),
    question("get_individual", "Get the name of an individual, such as a client, spouse, nominee or employee.", "name"),
  ],
  address: [
    question("find_address", "Find a street address, locality or city mentioned in the text.", "address"),
    question("get_location", "Get a postal address, flat, building, area, city or pincode written in the text.", "location"),
  ],
  account: [
    question(
      "find_account_number",
      "Find a bank account number, demat account number, mutual fund folio number, insurance policy number or loan account number.",
      "account_number",
    ),
    question("get_financial_number", "Get a financial account, folio, policy, loan, card or customer number.", "number"),
  ],
  id: [
    question(
      "find_id_number",
      "Find a government or tax identification number such as PAN, Aadhaar, passport, voter ID, driving licence or SSN.",
      "id_number",
    ),
    question("get_identity_document", "Get an identity document number such as PAN, Aadhaar, passport or licence.", "document_number"),
  ],
  secret: [
    question("find_credential", "Find a password, PIN, OTP, CVV or login username.", "credential"),
    question("get_secret", "Get a secret such as a password, passcode, security code or user ID.", "secret"),
  ],
  // Catch-all for any other personal or sensitive detail. Asked to copy the
  // text exactly as written so that find-and-replace on the document works.
  pii: [
    question(
      "find_pii",
      "Find personal or sensitive information in the text: a name, address, phone number, email, account number, ID number, password or date of birth. Return the exact text as it is written in the document.",
      "exact_quote",
    ),
    question(
      "report_sensitive_data",
      "Report one piece of private data that appears in the text, copied word for word, character for character.",
      "verbatim_text",
    ),
  ],
};

async function openSession(onDownloadProgress) {
  return createNeedle({
    model: asUrl("../vendor/model/needle3.cact"),
    modelSha256: MODEL_SHA256,
    workerUrl: asUrl("../vendor/needle/worker.js"),
    wasmUrl: asUrl("../vendor/needle/needle.wasm"),
    stateless: true,
    onDownloadProgress,
  });
}

// Output is a few words; cap it so a rambling answer cannot cost seconds.
const MAX_NEW_TOKENS = 80;

async function ask(session, kind, text, variant) {
  const res = await session.complete(text, { tools: QUESTIONS[kind][variant % 2], maxNewTokens: MAX_NEW_TOKENS });
  const call = res.function_calls?.[0];
  if (!call) return null;
  const value = Object.values(call.arguments ?? {})[0];
  return typeof value === "string" ? value.trim().replace(/[.,;:]+$/, "") : null;
}

/** One Needle session per CPU core (measured: N sessions run N questions in the time of one). */
export function defaultPoolSize() {
  return Math.max(2, Math.min(6, globalThis.navigator?.hardwareConcurrency || 2));
}

/**
 * Loads a pool of Needle sessions. `find(kind, text, variant)` waits for a free
 * session, so callers can fire as many questions at once as they like.
 * kinds: person, address, account, id, secret, pii.
 */
export async function loadDetector(onDownloadProgress, size = defaultPoolSize()) {
  const opened = await Promise.allSettled(Array.from({ length: size }, () => openSession(onDownloadProgress)));
  const sessions = opened.filter((o) => o.status === "fulfilled").map((o) => o.value);
  const failed = opened.find((o) => o.status === "rejected");
  if (failed) {
    // Do not leave the workers that did start running in the background.
    await Promise.allSettled(sessions.map((x) => x.close()));
    throw failed.reason;
  }
  const idle = [...sessions];
  const waiting = [];
  const acquire = () => (idle.length ? Promise.resolve(idle.pop()) : new Promise((resolve) => waiting.push(resolve)));
  const release = (s) => (waiting.length ? waiting.shift()(s) : idle.push(s));
  return {
    size,
    async find(kind, text, variant = 0) {
      const session = await acquire();
      try {
        return await ask(session, kind, text, variant);
      } finally {
        release(session);
      }
    },
    async close() {
      await Promise.allSettled(sessions.map((x) => x.close()));
    },
  };
}
