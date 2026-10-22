// One GLiNER session per worker so windows are scored in parallel. Each
// worker is single-threaded wasm (no SharedArrayBuffer), so no COOP/COEP
// headers are needed to serve the page.
import { Gliner } from "../vendor/gliner/gliner.bundle.js";

// WHY token-level: knowledgator/gliner-pii-small-v1.0 is a token-level model
// (span_mode token_level, ettin/ModernBERT encoder); its ONNX graph takes 4
// inputs, so GLiNER.js must use the TokenModel path.
const LABELS = ["person", "address", "PAN number", "folio number", "phone number", "email", "customer id", "bank account number", "passport number"];
let g;

const sigmoid = (x) => 1 / (1 + Math.exp(-x));

/**
 * WHY re-layout (not upstream GLiNER.js): knowledgator/gliner-pii-small-v1.0
 * exports logits as [batch, words, classes, 3] (last dim = start/end/inside,
 * verified against the python `gliner` decoder and onnxruntime output shape
 * `(1, 16, 9, 3)`), while GLiNER.js 0.0.19 TokenDecoder reads them as
 * [3, batch, words, classes]. Same element count, so the wrong layout runs
 * without errors but returns noise. Only the index math is replaced; span
 * assembly and greedySearch stay the bundled ones.
 */
function patchTokenDecoder(g) {
  const dec = g?.model?.decoder;
  if (!dec || typeof dec.decode !== "function" || typeof dec.greedySearch !== "function") return;
  dec.decode = (batchSize, inputLength, numEntities, texts, batchIds, wordsStart, wordsEnd, idToClass, flat, flatNer, threshold, multiLabel) => {
    const perWord = numEntities * 3;
    const words = Math.floor(flat.length / (batchSize * perWord)) || inputLength;
    const starts = Array.from({ length: batchSize }, () => []);
    const ends = Array.from({ length: batchSize }, () => []);
    const inside = Array.from({ length: batchSize }, () =>
      Array.from({ length: words }, () => new Array(numEntities).fill(0)));
    for (let id = 0; id < flat.length; id++) {
      const pos = id % 3;
      const entity = Math.floor(id / 3) % numEntities;
      const token = Math.floor(id / perWord) % words;
      const batch = Math.floor(id / (words * perWord)) % batchSize;
      const prob = sigmoid(flat[id]);
      if (prob >= threshold && token < (wordsEnd[batch] || []).length) {
        if (pos === 0) starts[batch].push([token, entity]);
        else if (pos === 1) ends[batch].push([token, entity]);
      }
      if (pos === 2 && token < words && entity < numEntities) inside[batch][token][entity] = prob;
    }
    const spans = [];
    for (let b = 0; b < batchSize; b++) {
      const out = [];
      for (const [st, cls] of starts[b]) {
        for (const [ed, cls2] of ends[b]) {
          if (ed < st || cls !== cls2) continue;
          const probs = inside[b].slice(st, ed + 1).map((row) => row[cls]);
          if (probs.some((v) => v < threshold)) continue;
          const score = probs.reduce((a, v) => a + v, 0) / probs.length;
          const from = (wordsStart[b] || [])[st];
          const to = (wordsEnd[b] || [])[ed];
          if (from == null || to == null) continue;
          out.push([texts[batchIds[b]].slice(from, to), from, to, idToClass[cls + 1], score]);
        }
      }
      spans.push(out);
    }
    return spans.map((s) => dec.greedySearch(s, flatNer, multiLabel));
  };
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === "init") {
      g = new Gliner({
        tokenizerPath: "knowledgator/gliner-pii-small-v1.0",
        modelType: "token-level",
        onnxSettings: {
          modelPath: new URL("../vendor/gliner/models/knowledgator/gliner-pii-small-v1.0/onnx/model_quint8.onnx", import.meta.url).href,
          executionProvider: "wasm",
          wasmPaths: new URL("../vendor/gliner/", import.meta.url).href,
          multiThread: false,
          fetchBinary: false,
        },
        transformersSettings: { allowLocalModels: true, useBrowserCache: false },
        maxWidth: 12,
      });
      await g.initialize();
      patchTokenDecoder(g);
      self.postMessage({ type: "ready" });
    } else {
      const r = await g.inference({ texts: [data.text], entities: LABELS, flatNer: true, threshold: data.threshold });
      self.postMessage({ type: "result", id: data.id, ents: (r[0] || []).map((e) => ({ label: e.label, word: e.spanText, score: e.score })) });
    }
  } catch (err) {
    self.postMessage({ type: "error", id: data.id, message: String(err && err.message || err) });
  }
};
