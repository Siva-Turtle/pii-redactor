const { chromium } = require(process.env.PW || "playwright");
(async () => {
  const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const p = await b.newPage();
  p.on("pageerror", (e) => console.log("pageerror:", e.message));
  await p.goto("http://localhost:8731/");
  const r = await p.evaluate(async () => {
    const { createNeedle, tool } = await import("/vendor/needle/needle-browser.js");
    const u = (r) => new URL(r, location.href).href;
    const n = await createNeedle({ model: u("/vendor/model/needle3.cact"), modelSha256: "c9d915eca282ed42d1a09b143b592adb4cc6744ffe2d294adf5cfc5548170c38", workerUrl: u("/vendor/needle/worker.js"), wasmUrl: u("/vendor/needle/needle.wasm"), stateless: true });
    const T = (name, d, arg) => ({ [name]: tool({ description: d, inputSchema: { type: "object", properties: { [arg]: { type: "string" } }, required: [arg] } }) });
    const tools = {
      account: T("find_account_number", "Find a bank account number, demat account number, mutual fund folio number, insurance policy number or loan account number.", "account_number"),
      idnum: T("find_id_number", "Find a government or tax identification number such as PAN, Aadhaar, passport, voter ID, driving licence or SSN.", "id_number"),
      secret: T("find_credential", "Find a password, PIN, OTP, CVV or login username.", "credential"),
      person: T("find_person", "Find the full name of a person mentioned in the text.", "person_name"),
    };
    const S = [
      "My HDFC savings account number is 50100234567891 and IFSC is HDFC0001234.",
      "Please credit the amount to a/c 912010045678901 at Axis Bank.",
      "Demat account: IN30012310234567 with Zerodha, DP ID 12081600.",
      "Our folio no 1234567/89 in the Axis Bluechip fund shows a gain.",
      "LIC policy number 123456789 matures in 2031.",
      "The Form 16 password is Hunter2! and the OTP is 482913.",
      "Login with username priya_nair87 and PIN 4821.",
      "Passport number K1234567 expires next year, voter ID ABC1234567.",
      "My PAN is ABCDE1234F and Aadhaar 1234 5678 9012.",
      "The mutual fund returned 12 percent and the NIFTY closed at 22000.",
      "Transfer 50000 rupees by NEFT tomorrow.",
    ];
    const out = [];
    for (const s of S) {
      const row = [s];
      for (const [k, t] of Object.entries(tools)) {
        try { const r = await n.complete(s, { tools: t }); row.push(k + "=" + JSON.stringify(r.function_calls.map((c) => Object.values(c.arguments)[0]))); } catch (e) { row.push(k + " ERR " + e.message); }
      }
      out.push(row.join(" | "));
    }
    return out;
  });
  console.log(r.join("\n"));
  await b.close();
})();
