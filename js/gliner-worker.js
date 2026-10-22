// One GLiNER session per worker so windows are scored in parallel. Each
// worker is single-threaded wasm (no SharedArrayBuffer), so no COOP/COEP
// headers are needed to serve the page.
import { Gliner } from "../vendor/gliner/gliner.bundle.js";

const LABELS = ["person", "address"];
let g;

self.onmessage = async ({ data }) => {
  try {
    if (data.type === "init") {
      g = new Gliner({
        tokenizerPath: "onnx-community/gliner_small-v2.1",
        onnxSettings: {
          modelPath: new URL("../vendor/gliner/models/onnx-community/gliner_small-v2.1/onnx/model_quantized.onnx", import.meta.url).href,
          executionProvider: "wasm",
          wasmPaths: new URL("../vendor/gliner/", import.meta.url).href,
          multiThread: false,
          fetchBinary: false,
        },
        transformersSettings: { allowLocalModels: true, useBrowserCache: false },
        maxWidth: 12,
      });
      await g.initialize();
      self.postMessage({ type: "ready" });
    } else {
      const r = await g.inference({ texts: [data.text], entities: LABELS, flatNer: true, threshold: data.threshold });
      self.postMessage({ type: "result", id: data.id, ents: (r[0] || []).map((e) => ({ label: e.label, word: e.spanText, score: e.score })) });
    }
  } catch (err) {
    self.postMessage({ type: "error", id: data.id, message: String(err && err.message || err) });
  }
};
