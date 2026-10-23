// Zero-shot GLiNER PII (Knowledgator pii-small, token-level, ModernBERT
// encoder) with custom PII labels: one pass per window asks for all labels
// together. Several workers each hold their own session; recognize() hands a
// window to whichever worker is free.
export const LABELS = ["person", "address", "PAN number", "folio number", "phone number", "email", "customer id", "bank account number", "passport number"];
// Plain message shown when the 83 MB weights were never downloaded (they stay
// git-ignored to keep the repo light). app.js surfaces this while still
// redacting with the pattern layer.
export const MODEL_MISSING_MSG =
  "AI model not downloaded: run tools/fetch-model.sh (or tools/fetch-model.ps1 on Windows)";

const MODEL_URL = new URL(
  "../vendor/gliner/models/knowledgator/gliner-pii-small-v1.0/onnx/model_quint8.onnx",
  import.meta.url,
).href;

// WHY a HEAD check on failure only: worker init errors from a missing model
// are obscure fetch/404 text, so confirm the file is really gone before
// replacing the error with MODEL_MISSING_MSG.
async function modelMissing() {
  try {
    const r = await fetch(MODEL_URL, { method: "HEAD" });
    if (r.ok) return false;
    if (r.status === 405 || r.status === 501) {
      const g = await fetch(MODEL_URL, { headers: { Range: "bytes=0-0" } });
      return !g.ok;
    }
    return true;
  } catch {
    return false; // cannot tell; keep the original error
  }
}

// WHY one worker first: each worker fetches the same 83 MB model file, and
  // starting them all at once makes parallel range/cache writes fail on static
  // hosts (net::ERR_CACHE_WRITE_FAILURE). The first "ready" warms the HTTP
  // cache, then the rest can start together. Extra workers may still fail, so
  // they are tolerated; only the first failure aborts (modelMissing check).
export async function startWorkerPool(size, createWorker) {
  const first = await createWorker();
  if (size <= 1) return [first];
  const rest = await Promise.allSettled(Array.from({ length: size - 1 }, () => createWorker()));
  const workers = [first];
  for (const r of rest) if (r.status === "fulfilled") workers.push(r.value);
  return workers;
}

export async function loadGliner() {
  const q = Number(new URLSearchParams(location.search).get("w"));
  // WHY half the cores (max 4): each worker holds a full model session, so
  // more workers cost memory without speeding up beyond this point (measured).
  // `?w=N` is a benchmark override, not part of the UI.
  const size = q > 0 ? q : Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 4) / 2)));
  const spawn = () => new Promise((resolve, reject) => {
    const w = new Worker(new URL("./gliner-worker.js", import.meta.url), { type: "module" });
    const fail = (err) => {
      try { w.terminate(); } catch { /* ignore */ }
      reject(err);
    };
    w.onmessage = ({ data }) => (data.type === "ready" ? resolve(w) : fail(new Error(data.message)));
    w.onerror = (e) => fail(new Error(e.message || "worker failed"));
    w.postMessage({ type: "init" });
  });
  let workers;
  try {
    workers = await startWorkerPool(size, spawn);
  } catch (err) {
    if (await modelMissing()) throw new Error(MODEL_MISSING_MSG);
    throw err;
  }
  const idle = [...workers];
  const waiting = [];
  let nextId = 0;
  const acquire = () => (idle.length ? Promise.resolve(idle.pop()) : new Promise((r) => waiting.push(r)));
  const release = (w) => (waiting.length ? waiting.shift()(w) : idle.push(w));
  return {
    size: workers.length,
    async recognize(text, threshold = 0.4) {
      const w = await acquire();
      const id = nextId++;
      try {
        return await new Promise((resolve, reject) => {
          w.onmessage = ({ data }) => (data.type === "error" ? reject(new Error(data.message)) : resolve(data.ents));
          w.postMessage({ id, text, threshold });
        });
      } finally {
        release(w);
      }
    },
  };
}
