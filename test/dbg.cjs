const { chromium } = require(process.env.PW || "playwright");
(async () => {
  const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const p = await b.newPage();
  p.on("pageerror", (e) => console.log("pageerror:", e.message));
  await p.goto("http://localhost:8765/");
  const r = await p.evaluate(async () => {
    const { loadDetector } = await import("/js/ai.js");
    const { Redactor } = await import("/js/redactor.js");
    const d = await loadDetector();
    const calls = [];
    const spy = { findPerson: async (t) => { const r = await d.findPerson(t); calls.push(["P", t, r]); return r; }, findAddress: async (t) => { const r = await d.findAddress(t); calls.push(["A", t, r]); return r; } };
    const r = new Redactor({ detector: spy });
    const text = "Dear Mr. Rajesh Kumar Sharma,\nPlease contact Priya Nair on +91 98765 43210 or priya.nair@example.com.\nPAN ABCDE1234F, Aadhaar 1234 5678 9012. DOB 02-04-1987.\nRegistered address: Flat 12B, Sunrise Apartments, Andheri West, Mumbai 400053.\nThe quarterly tax filing deadline is next week.";
    await r.learn([text]);
    return { calls, names: [...r.terms.NAME], out: r.apply(text) };
  });
  console.log(JSON.stringify(r, null, 1));
  await b.close();
})();
