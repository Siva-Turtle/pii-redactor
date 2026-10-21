// Needle layer: runs Cactus Needle 3 (a ~35 MB function-calling model) locally
// in the browser via WebAssembly to find the things regexes cannot — people's
// names and postal addresses.
//
// Needle is a tool-calling model, not a dedicated NER model, so each "detector"
// is a session with exactly ONE tool ("find_person" / "find_address"). The model
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

function singleStringTool(name, description, argName) {
  return {
    [name]: tool({
      description,
      inputSchema: { type: "object", properties: { [argName]: { type: "string" } }, required: [argName] },
    }),
  };
}

async function openSession(tools, onDownloadProgress) {
  return createNeedle({
    model: asUrl("../vendor/model/needle3.cact"),
    modelSha256: MODEL_SHA256,
    workerUrl: asUrl("../vendor/needle/worker.js"),
    wasmUrl: asUrl("../vendor/needle/needle.wasm"),
    tools,
    stateless: true,
    onDownloadProgress,
  });
}

async function ask(session, text) {
  const res = await session.complete(text);
  const call = res.function_calls?.[0];
  if (!call) return null;
  const value = Object.values(call.arguments ?? {})[0];
  return typeof value === "string" ? value.trim().replace(/[.,;:]+$/, "") : null;
}

/**
 * Loads two Needle sessions (they run in parallel in separate workers).
 * @returns {Promise<{ findPerson(text:string):Promise<string|null>, findAddress(text:string):Promise<string|null>, close():Promise<void> }>}
 */
export async function loadDetector(onDownloadProgress) {
  const person = await openSession(
    singleStringTool("find_person", "Find the full name of a person mentioned in the text.", "person_name"),
    onDownloadProgress,
  );
  const address = await openSession(
    singleStringTool("find_address", "Find a street address, locality or city mentioned in the text.", "address"),
    onDownloadProgress,
  );
  return {
    findPerson: (text) => ask(person, text),
    findAddress: (text) => ask(address, text),
    async close() {
      await Promise.allSettled([person.close(), address.close()]);
    },
  };
}
