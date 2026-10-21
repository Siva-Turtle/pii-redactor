const { chromium } = require(process.env.PW || "playwright");
(async () => {
  const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const p = await b.newPage();
  await p.goto("http://localhost:8731/");
  const r = await p.evaluate(async () => {
    const { loadDetector } = await import("/js/ai.js");
    const d = await loadDetector(undefined, 1);
    const S = "Password for the Form 16 PDF is sunshine99 and the OTP is 482913.";
    const out = [];
    const run = async (label, kind, text, v = 0) => { const a = await d.find(kind, text, v); out.push(label + " -> " + JSON.stringify(a)); };
    await run("secret fresh", "secret", S);
    await run("secret again", "secret", S);
    await run("person on S", "person", S);
    await run("secret after person", "secret", S);
    await run("pii on S", "pii", S);
    await run("secret after pii", "secret", S);
    await run("address on S", "address", S);
    await run("account on S", "account", S);
    await run("id on S", "id", S);
    await run("secret after id", "secret", S);
    await run("secret v1", "secret", S, 1);
    await run("secret v0 after v1", "secret", S, 0);
    return out;
  });
  console.log(r.join("\n"));
  await b.close();
})();
