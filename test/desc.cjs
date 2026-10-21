const { chromium } = require(process.env.PW || "playwright");
(async () => {
  const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const p = await b.newPage();
  await p.goto("http://localhost:8731/");
  const r = await p.evaluate(async () => {
    const { createNeedle, tool } = await import("/vendor/needle/needle-browser.js");
    const u = (r) => new URL(r, location.href).href;
    const n = await createNeedle({ model: u("/vendor/model/needle3.cact"), modelSha256: "c9d915eca282ed42d1a09b143b592adb4cc6744ffe2d294adf5cfc5548170c38", workerUrl: u("/vendor/needle/worker.js"), wasmUrl: u("/vendor/needle/needle.wasm"), stateless: true });
    const Q = (d, arg) => ({ f: tool({ description: d, inputSchema: { type: "object", properties: { [arg]: { type: "string" } }, required: [arg] } }) });
    const S = ["Password for the Form 16 PDF is sunshine99 and the OTP is 482913.", "Login with username priya_nair87 and PIN 4821.", "The mutual fund returned 12 percent."];
    const D = {
      short: "Find a password, PIN, OTP, CVV or username.",
      original: "Find a password, PIN, OTP, CVV or login username.",
      explicit: "Find the actual password, PIN, OTP, CVV or login username value written in the text.",
    };
    const out = {};
    for (const [k, d] of Object.entries(D)) {
      out[k] = [];
      for (const s of S) { const t0 = performance.now(); const r = await n.complete(s, { tools: Q(d, "credential"), maxNewTokens: 80 }); out[k].push(JSON.stringify(r.function_calls.map((c) => Object.values(c.arguments)[0])) + " " + Math.round(performance.now() - t0) + "ms"); }
    }
    // does the token cap matter?
    const t = await n.complete(S[0], { tools: Q(D.original, "credential") });
    out.nocap = JSON.stringify(t.function_calls.map((c) => Object.values(c.arguments)[0]));
    return out;
  });
  console.log(JSON.stringify(r, null, 1));
  await b.close();
})();
