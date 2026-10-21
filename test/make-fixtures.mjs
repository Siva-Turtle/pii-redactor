// Generates sample files full of FAKE personal data. Run: node test/make-fixtures.mjs
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const require = createRequire(new URL("../tools/", import.meta.url).href + "x.js");
const JSZip = require("jszip"), XLSX = require("xlsx"), { PDFDocument, StandardFonts } = require("pdf-lib");
const dir = new URL("./fixtures/", import.meta.url).pathname;

const lines = [
  "Dear Mr. Rajesh Kumar Sharma,",
  "Please contact Priya Nair on +91 98765 43210 or priya.nair@example.com.",
  "PAN ABCDE1234F, Aadhaar 1234 5678 9012. DOB 02-04-1987.",
  "Registered address: Flat 12B, Sunrise Apartments, Andheri West, Mumbai 400053.",
  "The quarterly tax filing deadline is next week.",
];
writeFileSync(dir + "sample.txt", lines.join("\n"));
writeFileSync(dir + "sample.md", "# Notes\n\n- " + lines.join("\n- ") + "\n");
writeFileSync(dir + "sample.csv", 'Client Name,Mobile,Notes,Amount\n"Sharma, Rajesh",9876543210,"Spoke with Priya Nair about SIP",1200\nAnita Desai,9123456780,Tax filing deadline is next week,3400\n');

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
  ["Customer Name", "Email", "Comments", "Units"],
  ["Anita Desai", "anita@example.com", "Wire sent to Meera Rathore, PAN ABCDE1234F", 10],
  ["Vikram Rathore", "vik@example.com", "Mutual funds grew in March", 25],
]), "Clients");
XLSX.writeFile(wb, dir + "sample.xlsx");

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const run = (t, b) => `<w:r>${b ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t xml:space="preserve">${t}</w:t></w:r>`;
const body = `<w:p>${run("Dear ")}${run("Priya Na", true)}${run("ir", true)}${run(", your email is priya.nair@example.com and phone +91 98765 43210.")}</w:p>
<w:p>${run("Nothing sensitive in this paragraph about taxes.")}</w:p>`;
const z = new JSZip();
z.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
z.file("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
z.file("word/document.xml", `<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>`);
z.file("docProps/core.xml", `<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>Secret Author</dc:creator><cp:lastModifiedBy>Other Person</cp:lastModifiedBy></cp:coreProperties>`);
writeFileSync(dir + "sample.docx", await z.generateAsync({ type: "uint8array" }));

const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica);
const page = pdf.addPage([595, 842]);
lines.forEach((l, i) => page.drawText(l, { x: 50, y: 780 - i * 28, size: 12, font }));
writeFileSync(dir + "sample.pdf", await pdf.save());

const blank = await PDFDocument.create(); blank.addPage([300, 300]);
writeFileSync(dir + "scan-like.pdf", await blank.save());
console.log("fixtures written");

// Mixed fonts/sizes with PII mid-line; records each PII string's exact extent
// (from the font's own metrics) so the e2e can pixel-check the black boxes.
{
  const { StandardFonts: F } = require("pdf-lib");
  const doc = await PDFDocument.create();
  const fonts = { H: await doc.embedFont(F.Helvetica), T: await doc.embedFont(F.TimesRoman), C: await doc.embedFont(F.Courier) };
  const pg = doc.addPage([595, 842]);
  const rows = [
    ["H", 12, "Mail me at priya.nair@example.com, WWiimm iiill call later", "priya.nair@example.com"],
    ["T", 14, "Her PAN is ABCDE1234F and that is all illicit lilies", "ABCDE1234F"],
    ["C", 11, "Phone +91 98765 43210 (mobile) or 98765-43211 work", "+91 98765 43210"],
    ["H", 9, "Small print: Aadhaar 1234 5678 9012 mmmm, DOB 02-04-1987.", "1234 5678 9012"],
    ["T", 16, "Wide: MMMMMM abc@mmmmmm.org WWWWWW iiiiii", "abc@mmmmmm.org"],
    ["H", 12, "Line with 2 hits: x@y.co and ABCDE1234F end", "x@y.co"],
    ["H", 12, "Line with 2 hits: x@y.co and ABCDE1234F end", "ABCDE1234F"],
  ];
  const expected = [];
  rows.forEach(([k, size, text, pii], i) => {
    const y = 780 - i * 40, x = 50, f = fonts[k];
    pg.drawText(text, { x, y, size, font: f });
    const at = text.indexOf(pii);
    const x0 = x + f.widthOfTextAtSize(text.slice(0, at), size);
    const x1 = x + f.widthOfTextAtSize(text.slice(0, at + pii.length), size);
    expected.push({ pii, x0, x1, top: 842 - (y + 0.7 * size), bottom: 842 - (y - 0.15 * size) });
  });
  writeFileSync(dir + "mixed.pdf", await doc.save());
  writeFileSync(dir + "mixed.expected.json", JSON.stringify(expected));
}
