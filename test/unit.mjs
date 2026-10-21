// Run with: node test/unit.mjs
import assert from "node:assert";
import { findPatternSpans, applySpans } from "../js/patterns.js";
import { Redactor, chunkText, cleanHit } from "../js/redactor.js";
import { parseCsv, stringifyCsv } from "../js/csv.js";

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
  assert.match(m, /\[DATE\]/, d);
  assert.doesNotMatch(m, /1987|1962|2026/, d);
}
assert.doesNotMatch(mask("Please confirm 2026-08-21.", { dates: false }), /\[/);
assert.match(mask("Please confirm 2026-08-21.", { dates: false }) , /2026-08-21/);

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
  const r = new Redactor({ detector: fake });
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
  const r = new Redactor({ detector: fake });
  await r.learn(["Wire to Acme Wealth Pvt Ltd today"]);
  assert.strictEqual(r.apply("Our wealth plan grew"), "Our wealth plan grew");
}
{
  // Grounding: a hallucinated answer that is not in the text must be ignored.
  const liar = { findPerson: async () => "Nobody Here", findAddress: async () => null };
  const r = new Redactor({ detector: liar });
  await r.learn(["The tax deadline is Friday."]);
  assert.strictEqual(r.apply("The tax deadline is Friday."), "The tax deadline is Friday.");
}
{
  // Budget cut-off is reported.
  const r = new Redactor({ detector: fake });
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
  const r = new Redactor({ detector: det });
  const doc = "Address: Flat 12B, Andheri West, Mumbai 400053.";
  await r.learn([doc]);
  assert.doesNotMatch(r.apply(doc), /Flat|Mumbai|400053/);
}
// A single acronym such as PAN is not a person.
{
  const r = new Redactor({ detector: { findPerson: async () => "PAN", findAddress: async () => null } });
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
  const r = new Redactor({ detector: { findPerson: async () => "Registered", findAddress: async () => null } });
  await r.learn(["Registered office is closed."]);
  assert.strictEqual(r.apply("Registered office is closed."), "Registered office is closed.");
}
console.log("All unit tests passed.");
