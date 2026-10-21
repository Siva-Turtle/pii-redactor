const { chromium } = require(process.env.PW || "playwright");
(async () => {
  const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const p = await b.newPage();
  p.on("pageerror", (e) => console.log("pageerror:", e.message));
  await p.goto("http://localhost:8731/");
  const r = await p.evaluate(async () => {
    const { createNeedle, tool } = await import("/vendor/needle/needle-browser.js");
    const u = (r) => new URL(r, location.href).href;
    const open = () => createNeedle({ model: u("/vendor/model/needle3.cact"), modelSha256: "c9d915eca282ed42d1a09b143b592adb4cc6744ffe2d294adf5cfc5548170c38", workerUrl: u("/vendor/worker.js".replace("/vendor/", "/vendor/needle/")), wasmUrl: u("/vendor/needle/needle.wasm"), stateless: true });
    const Q = (name, d) => ({ [name]: tool({ description: d, inputSchema: { type: "object", properties: { v: { type: "string" } }, required: ["v"] } }) });
    const long = Q("find_pii", "Find personal or sensitive information in the text: a name, address, phone number, email, account number, ID number, password or date of birth. Return the exact text as it is written in the document.");
    const short = Q("find_pii", "Find a person's name.");
    const text = "Please contact Priya Nair on the Mumbai office about the quarterly filing.";
    const time = async (n, tools, opts = {}) => { const t0 = performance.now(); let r; for (let i = 0; i < 3; i++) r = await n.complete(text, { tools, ...opts }); return { ms: Math.round((performance.now() - t0) / 3), ans: JSON.stringify(r.function_calls) }; };
    const out = {};
    const n1 = await open();
    out.long = await time(n1, long);
    out.short = await time(n1, short);
    out.long_cap = await time(n1, long, { maxNewTokens: 40 });
    // parallel scaling: k sessions each doing 3 calls at once
    const sessions = [n1]; 
    for (const k of [2, 4]) {
      while (sessions.length < k) sessions.push(await open());
      const t0 = performance.now();
      await Promise.all(sessions.slice(0, k).map(async (s) => { for (let i = 0; i < 3; i++) await s.complete(text, { tools: long }); }));
      out["parallel" + k] = Math.round((performance.now() - t0) / 3) + "ms per round of " + k + " calls";
    }
    out.cores = navigator.hardwareConcurrency;
    return out;
  });
  console.log(JSON.stringify(r, null, 1));
  await b.close();
})();
