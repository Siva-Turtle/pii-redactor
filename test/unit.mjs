// Run with: node test/unit.mjs
import assert from "node:assert";
import { findPatternSpans, applySpans } from "../js/patterns.js";
import { Redactor, chunkText, cleanHit, parseManual } from "../js/redactor.js";
import { parseCsv, stringifyCsv } from "../js/csv.js";

// Adapts simple per-question fakes to the detector interface: find(kind, text, variant).
const METHOD = { person: "findPerson", address: "findAddress", account: "findAccount", id: "findId", secret: "findSecret" };
const wrap = (o) => ({ find: async (kind, text) => (await o[METHOD[kind]]?.(text)) ?? null });
const mask = (t, o) => applySpans(t, findPatternSpans(t, o));

// --- patterns (cases ported from the CRM's piiMasking.test.js)
assert.match(mask("My PAN is ABCDE1234F, please."), /\[PAN\]/);
assert.match(mask("Aadhaar number 1234 5678 9012 for verification."), /\[AADHAAR\]/);
assert.match(mask("transfer to IFSC HDFC0001234."), /\[IFSC\]/);
assert.match(mask("Call me on +91 9876543210 after 5pm."), /\[PHONE\]/);
assert.match(mask("Send to neha@turtlefinance.in please."), /\[EMAIL\]/);
{
  const m = mask("Card 4111 1111 1111 1111 was declined.");
  assert.match(m, /\[CARD\]/);
  assert.doesNotMatch(m, /AADHAAR|PHONE/);
}
assert.match(mask("SSN - 724-79-7967"), /\[SSN\]/);
{
  const m = mask("My SSN is 724 79 7967 for the tax filing.");
  assert.match(m, /\[SSN\]/);
  assert.doesNotMatch(m, /AADHAAR/);
}
{
  const msg = "Can you please share the tax filing deadline for this quarter?";
  assert.strictEqual(mask(msg), msg);
}
assert.strictEqual(mask(""), "");

// --- new in this repo
assert.match(mask("Pay to rahul@oksbi now"), /\[UPI\]/);
assert.match(mask("GSTIN 27AAPFU0939F1ZV"), /\[GSTIN\]/);
assert.match(mask("Account 123456789012345678 held"), /\[ACCOUNT\]/);
assert.match(mask("Server 192.168.1.20 down"), /\[IP\]/);
for (const d of ["Form 16 pwd: 02-04-1987", "born 1962-11-07", "DOB 2 April 1987", "DOB April 2, 1987", "on 21-Aug-2026"]) {
  const m = mask(d);
  assert.match(m, /\[(?:DATE|SECRET)\]/, d);
  assert.doesNotMatch(m, /1987|1962|2026/, d);
}
assert.doesNotMatch(mask("Please confirm 2026-08-21.", { dates: false }), /\[/);
assert.match(mask("Please confirm 2026-08-21.", { dates: false }) , /2026-08-21/);

// --- finance identifiers
{
  const cases = [
    ["savings account number is 50100234567891", "ACCOUNT", "50100234567891"],
    ["a/c 5010 0234 5678 91 at Axis", "ACCOUNT", "5678 91"],
    ["Demat account: IN30012310234567", "DEMAT", "30012310234567"],
    ["DP ID 12081600", "DEMAT", "12081600"],
    ["folio no 1234567/89", "FOLIO", "1234567/89"],
    ["LIC policy number 123456789", "POLICY", "123456789"],
    ["Passport number K1234567", "ID", "K1234567"],
    ["voter ID ABC1234567", "ID", "ABC1234567"],
    ["Aadhaar no 1234 1234 1234", "AADHAAR", "1234 1234"],
    ["The password is Hunter2! ok", "SECRET", "Hunter2"],
    ["OTP is 482913.", "SECRET", "482913"],
    ["Amex 3782 822463 10005", "CARD", "10005"],
    ["TAN MUMA12345B", "TAN", "MUMA12345B"],
    ["Card 4111 1111 1111 1111", "CARD", "4111"],
  ];
  for (const [text, type, leak] of cases) {
    const m = mask(text);
    assert.match(m, new RegExp(`\\[${type}\\]`), text);
    assert.ok(!m.includes(leak), `${text} leaked ${leak}: ${m}`);
  }
  for (const ok of ["pin code 400053 is Mumbai", "NIFTY closed at 22000 and the account was closed", "Transfer 50000 rupees by NEFT", "The password policy will change"])
    assert.strictEqual(mask(ok), ok, ok);
}

// --- redactor with a fake detector standing in for Needle
const fake = {
  async findPerson(t) {
    for (const n of ["Priya Nair", "Meera Rathore", "Acme Wealth Pvt Ltd"]) if (t.includes(n)) return n;
    return null;
  },
  async findAddress(t) {
    return t.includes("42 MG Road, Bengaluru 560001") ? "42 MG Road, Bengaluru 560001" : null;
  },
};
{
  const r = new Redactor({ detector: wrap(fake) });
  const doc = "Please contact Priya Nair and Meera Rathore. Priya will call. Office: 42 MG Road, Bengaluru 560001. Mail priya@x.com";
  const prog = [];
  await r.learn([doc], { onProgress: (i, n) => prog.push([i, n]) });
  const out = r.apply(doc);
  assert.doesNotMatch(out, /Priya|Meera|Nair|Rathore|MG Road|priya@x\.com/);
  assert.match(out, /\[NAME\] and \[NAME\]\. \[NAME\] will call\./);
  assert.match(out, /\[ADDRESS\]/);
  assert.match(out, /\[EMAIL\]/);
  assert.ok(prog.length >= 1);
  assert.strictEqual(r.counts.NAME, 3);
}
{
  // Corporate names must not leak their words into token-level matching ("Wealth").
  const r = new Redactor({ detector: wrap(fake) });
  await r.learn(["Wire to Acme Wealth Pvt Ltd today"]);
  assert.strictEqual(r.apply("Our wealth plan grew"), "Our wealth plan grew");
}
{
  // Grounding: a hallucinated answer that is not in the text must be ignored.
  const liar = { findPerson: async () => "Nobody Here", findAddress: async () => null };
  const r = new Redactor({ detector: wrap(liar) });
  await r.learn(["The tax deadline is Friday."]);
  assert.strictEqual(r.apply("The tax deadline is Friday."), "The tax deadline is Friday.");
}
{
  // Budget cut-off is reported.
  const r = new Redactor({ detector: wrap(fake) });
  const res = await r.learn(Array.from({ length: 10 }, (_, i) => `Section ${i} Text here.`), { maxChunks: 3 });
  assert.strictEqual(res.truncated, true);
  assert.strictEqual(res.scanned, 3);
}
{
  const r = new Redactor();
  assert.strictEqual(r.apply("no detector, mail a@b.co"), "no detector, mail [EMAIL]");
  assert.ok(chunkText("Word ".repeat(300)).every((c) => c.length <= 200));
  assert.deepStrictEqual(chunkText("Regards,\nAnita Desai\nA much longer sentence follows here, with enough words to stand alone as its own chunk entirely."), ["Regards, Anita Desai", "A much longer sentence follows here, with enough words to stand alone as its own chunk entirely."]);
}

// --- finance kinds from the model: typed, grounded, and never a kept date
{
  const det = {
    findPerson: async () => null,
    findAddress: async () => null,
    findAccount: async (t) => (t.includes("LIC/0034/998877") ? "Policy LIC/0034/998877" : t.includes("2026-08-21") ? "2026-08-21" : null),
    findId: async (t) => (t.includes("ZX-AB-99812") ? "ZX-AB-99812" : null),
    findSecret: async (t) => (t.includes("sunshine99") ? "sunshine99" : null),
  };
  const r = new Redactor({ dates: false, detector: wrap(det) });
  const doc = "Policy LIC/0034/998877 matures. ZX-AB-99812 is my licence. Login pass sunshine99 works. Call on 2026-08-21.";
  await r.learn([doc]);
  const out = r.apply(doc);
  assert.doesNotMatch(out, /LIC\/0034|ZX-AB|sunshine99/);
  assert.match(out, /\[ACCOUNT\]/);
  assert.match(out, /\[ID\]/);
  assert.match(out, /\[SECRET\]/);
  assert.match(out, /2026-08-21/, "a date the user chose to keep must stay");
}
// A phrase reported as an ID must not shadow the address it came from.
{
  const doc = "Registered address: Flat 12B, Sunrise Apartments, Andheri West, Mumbai 400053.";
  const det = { findPerson: async () => null, findAddress: async () => "Flat 12B, Sunrise Apartments, Andheri West, Mumbai 400053", findAccount: async () => null, findId: async () => "Flat 12B, Sunrise Apartments, Andheri West, Mumbai 400053" };
  const r = new Redactor({ detector: wrap(det) });
  await r.learn([doc]);
  assert.strictEqual(r.apply(doc), "Registered address: [ADDRESS].");
}
// --- cue names work with no AI at all
{
  const r = new Redactor();
  const doc = "Dear Mr. Rajesh Kumar Sharma,\nMy spouse Meera Rathore agrees. Dear Team, thanks.\nRegards,\nAnita Desai";
  await r.learn([doc]);
  const out = r.apply(doc);
  assert.doesNotMatch(out, /Rajesh|Sharma|Meera|Rathore|Anita|Desai/);
  assert.match(out, /Dear Team/);
  assert.match(out, /Rajesh|Dear Mr\. \[NAME\]/);
}
// An address hit wins over a name hit that sits inside it.
{
  const det = { findPerson: async (t) => (t.includes("Andheri West") ? "Andheri West" : null), findAddress: async (t) => (t.includes("Flat 12B") ? "Flat 12B, Andheri West, Mumbai 400053" : null) };
  const r = new Redactor({ detector: wrap(det) });
  const doc = "Address: Flat 12B, Andheri West, Mumbai 400053.";
  await r.learn([doc]);
  assert.doesNotMatch(r.apply(doc), /Flat|Mumbai|400053/);
}
// A single acronym such as PAN is not a person.
{
  const r = new Redactor({ detector: wrap({ findPerson: async () => "PAN", findAddress: async () => null }) });
  await r.learn(["PAN is required."]);
  assert.strictEqual(r.apply("PAN is required."), "PAN is required.");
}
// --- csv round trip keeps quoting, leading zeros and separators
{
  const src = 'name,phone,note\r\n"Doe, Jane",007,"said ""hi""\nthere"\r\n';
  const rows = parseCsv(src);
  assert.deepStrictEqual(rows[1], ["Doe, Jane", "007", 'said "hi"\nthere']);
  assert.strictEqual(stringifyCsv(rows), src);
  assert.deepStrictEqual(parseCsv("a;b\n1;2", undefined), [["a", "b"], ["1", "2"]]);
}
assert.strictEqual(cleanHit("Dear Mr. Rajesh Kumar Sharma,"), "Rajesh Kumar Sharma");
assert.strictEqual(cleanHit("Dr Priya Nair."), "Priya Nair");
{
  const r = new Redactor({ detector: wrap({ findPerson: async () => "Registered", findAddress: async () => null }) });
  await r.learn(["Registered office is closed."]);
  assert.strictEqual(r.apply("Registered office is closed."), "Registered office is closed.");
}
// --- the loop: stops only after TWO consecutive runs find nothing new
{
  const calls = [];
  const det = {
    async find(kind, text, variant) {
      calls.push({ kind, variant, text });
      if (kind === "pii" && variant === 0 && text.includes("Zed Quux")) return "Zed   Quux"; // sloppy whitespace
      return null;
    },
  };
  const r = new Redactor({ detector: det });
  const doc = "Please note that Zed Quux called Priya Banerjee twice.";
  await r.learn([doc]);
  const pii = calls.filter((c) => c.kind === "pii");
  // run 1 (variant 0) finds it; runs 2 and 3 (variants 1, 0) are empty -> stop. Exactly 3 runs.
  assert.deepStrictEqual(pii.map((c) => c.variant), [0, 1, 0]);
  // the found text is blanked out before the next run, so it is not asked about again
  assert.ok(!pii[1].text.includes("Quux"));
  // the stored term is the document's own spelling, so find-and-replace works
  assert.strictEqual(r.apply(doc), "Please note that [NAME] called Priya Banerjee twice.");
}
{
  // a chunk where nothing is ever found takes exactly two runs
  const calls = [];
  const r = new Redactor({ detector: { find: async (k, t, v) => (calls.push([k, v]), null) } });
  await r.learn(["Nothing sensitive in this sentence at all."]);
  assert.deepStrictEqual(calls.filter(([k]) => k === "pii").map(([, v]) => v), [0, 1]);
}
{
  // quick mode: one empty run is enough
  const calls = [];
  const r = new Redactor({ thorough: false, detector: { find: async (k, t, v) => (calls.push([k, v]), null) } });
  await r.learn(["Nothing sensitive in this sentence at all."]);
  assert.deepStrictEqual(calls.filter(([k]) => k === "pii").map(([, v]) => v), [0]);
}
{
  // time budget stops the scan and reports it
  const r = new Redactor({ detector: { find: async () => (await new Promise((res) => setTimeout(res, 30)), null) } });
  const res = await r.learn(Array.from({ length: 20 }, (_, i) => `Sentence number ${i} here.`), { maxMs: 100 });
  assert.strictEqual(res.truncated, true);
  assert.ok(res.scanned >= 1 && res.scanned < 20);
}
{
  // a model that keeps returning junk can never loop forever
  let n = 0;
  const r = new Redactor({ detector: { find: async () => (n++, "Keep Going " + n) } });
  await r.learn(["Some text with Keep Going words."]);
  assert.ok(n < 100);
}
{
  // generic answers are typed by shape and filtered
  const answers = ["Anita Desai", "tax filing", "CRN 55-123-77"];
  let i = 0;
  const r = new Redactor({ detector: { find: async (k) => (k === "pii" ? answers[i++] ?? null : null) } });
  const doc = "Anita Desai asked about tax filing; ref CRN 55-123-77 noted.";
  await r.learn([doc]);
  const out = r.apply(doc);
  assert.doesNotMatch(out, /Anita|Desai|55-123-77/);
  assert.match(out, /tax filing/, "lowercase plain words are not PII");
}
// --- the user's own list: exact words/lines, case- and spacing-insensitive, beats everything
{
  assert.deepStrictEqual(parseManual("Project Falcon, Acme Wealth Pvt Ltd ,,\nSite 7"), ["Project Falcon", "Acme Wealth Pvt Ltd", "Site 7"]);
  const r = new Redactor({ manual: parseManual("Project Falcon, acme wealth pvt ltd, +91 98765") });
  const out = r.apply("About project   FALCON: Acme Wealth Pvt Ltd called +91 98765 43210 (not Falconry).");
  assert.strictEqual(out, "About [REDACTED]: [REDACTED] called [REDACTED] 43210 (not Falconry).");
  assert.strictEqual(r.counts.CUSTOM, 3);
  assert.strictEqual(new Redactor({ manual: [] }).apply("nothing here"), "nothing here");
}
// --- a lone sentence-opening word is not a name; a mid-sentence one still is
{
  const det = { find: async (k, t) => (k === "person" ? (t.startsWith("Line") ? "Line" : t.includes("Priya") ? "Priya" : null) : null) };
  const r = new Redactor({ detector: det });
  await r.learn(["Line one of the report.", "Please ask Priya about it."]);
  assert.strictEqual(r.apply("Line one of the report."), "Line one of the report.");
  assert.strictEqual(r.apply("Please ask Priya about it."), "Please ask [NAME] about it.");
}
console.log("All unit tests passed.");
