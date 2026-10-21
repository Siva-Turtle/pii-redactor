// Needle layer: runs Cactus Needle 3 (a ~35 MB function-calling model) locally
// in the browser via WebAssembly to find what regexes cannot: names, postal
// addresses, and finance identifiers written in unusual ways (account, demat,
// folio and policy numbers, government IDs, passwords/PINs/OTPs).
//
// Needle is a tool-calling model, not a dedicated NER model, so each question
// is asked with exactly ONE tool ("find_person", "find_address", ...). The model
// reports what it finds as the tool argument. Measured behaviour (see README):
//   * one tool per session is far more reliable than several tools at once
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
const QUESTIONS = {
  person: question("find_person", "Find the full name of a person mentioned in the text.", "person_name"),
  address: question("find_address", "Find a street address, locality or city mentioned in the text.", "address"),
  account: question(
    "find_account_number",
    "Find a bank account number, demat account number, mutual fund folio number, insurance policy number or loan account number.",
    "account_number",
  ),
  id: question(
    "find_id_number",
    "Find a government or tax identification number such as PAN, Aadhaar, passport, voter ID, driving licence or SSN.",
    "id_number",
  ),
  secret: question("find_credential", "Find a password, PIN, OTP, CVV or login username.", "credential"),
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

async function ask(session, kind, text) {
  const res = await session.complete(text, { tools: QUESTIONS[kind] });
  const call = res.function_calls?.[0];
  if (!call) return null;
  const value = Object.values(call.arguments ?? {})[0];
  return typeof value === "string" ? value.trim().replace(/[.,;:]+$/, "") : null;
}

/**
 * Loads two Needle sessions (separate workers, so two questions run at once).
 * Session 1 answers person/credential questions, session 2 address/account/ID.
 */
export async function loadDetector(onDownloadProgress) {
  const one = await openSession(onDownloadProgress);
  const two = await openSession(onDownloadProgress);
  return {
    findPerson: (t) => ask(one, "person", t),
    findSecret: (t) => ask(one, "secret", t),
    findAddress: (t) => ask(two, "address", t),
    findAccount: (t) => ask(two, "account", t),
    findId: (t) => ask(two, "id", t),
    async close() {
      await Promise.allSettled([one.close(), two.close()]);
    },
  };
}
