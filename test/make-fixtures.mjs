// Generates sample files full of FAKE personal data. Run: node test/make-fixtures.mjs
// Encrypted fixtures ("locked.*", password "correct-horse") are produced with
// sandbox-only Python tooling (pypdf for PDF, msoffcrypto-tool for Office),
// which is why this step shells out to python3. Those packages are only needed
// to *generate* fixtures, never at runtime (the page stays dependency-free).
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const require = createRequire(new URL("../tools/", import.meta.url).href + "x.js");
const JSZip = require("jszip"), XLSX = require("xlsx"), { PDFDocument, StandardFonts } = require("pdf-lib");
const dir = fileURLToPath(new URL("./fixtures/", import.meta.url));
mkdirSync(dir, { recursive: true });

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

writeFileSync(dir + "finance.txt", [
  "Client: Rajesh Kumar Sharma (spouse Meera Sharma). PAN ABCDE1234F, Aadhaar 1234 5678 9012.",
  "Kindly credit my SBI savings A/C no. 3456-7890-1234 and send the statement to rajesh.sharma@example.com.",
  "Demat account: IN30012310234567, DP ID 12081600, folio no 1234567/89 in the Axis Bluechip fund.",
  "The LIC policy LIC/0034/998877 matures in 2031; loan reference HL-445566-77 is closed.",
  "Password for the Form 16 PDF is sunshine99 and the OTP is 482913. Call +91 98765 43210.",
  "Passport K1234567 and voter ID ABC1234567 are attached. Born 2 April 1987.",
  "Office: Flat 12B, Sunrise Apartments, Andheri West, Mumbai 400053.",
  "NIFTY closed at 22000 and the mutual fund returned 12 percent; the tax filing deadline is next week.",
].join("\n"));

// ---- edge cases
{
  const W2 = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const r = (t) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`;
  const z2 = new JSZip();
  z2.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  z2.file("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  z2.file("word/_rels/document.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="mailto:secret.person@example.com" TargetMode="External"/></Relationships>`);
  z2.file("word/document.xml", `<?xml version="1.0"?><w:document ${W2}><w:body>
    <w:p>${r("Project Falcon status")}</w:p>
    <w:tbl><w:tr><w:tc><w:p>${r("PAN: ABCDE")}${r("1234F")}</w:p></w:tc><w:tc><w:p>${r("Phone 98765 43210")}</w:p></w:tc></w:tr></w:tbl>
  </w:body></w:document>`);
  z2.file("word/header1.xml", `<?xml version="1.0"?><w:hdr ${W2}><w:p>${r("Confidential: acme wealth pvt ltd")}</w:p></w:hdr>`);
  writeFileSync(dir + "edge.docx", await z2.generateAsync({ type: "uint8array" }));

  const wb2 = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([["Client", "DOB", "Note"], ["x", new Date(Date.UTC(1987, 3, 2)), "call Project Falcon team"]]);
  ws["B2"].z = "dd-mm-yyyy"; ws["B2"].t = "d";
  XLSX.utils.book_append_sheet(wb2, ws, "Data");
  XLSX.writeFile(wb2, dir + "edge.xlsx", { cellDates: true });

  writeFileSync(dir + "edge.csv", "﻿Name;Mobile;Remark\r\n\"Doe; Jane\";0098765;\"line one\nProject Falcon line two\"\r\n");
  writeFileSync(dir + "edge.txt", "Line one\r\nCall +91 98765 43210\r\nProject Falcon is secret.\r\n");

  const mp = await PDFDocument.create();
  const f = await mp.embedFont(StandardFonts.Helvetica);
  for (const txt of ["Page one mail a@b.co", "Page two PAN ABCDE1234F and Project Falcon"]) {
    mp.addPage([400, 300]).drawText(txt, { x: 30, y: 200, size: 12, font: f });
  }
  writeFileSync(dir + "multi.pdf", await mp.save());
}

// ---- bug-hunt fixtures
{
  const { degrees } = require("pdf-lib");
  const rp = await PDFDocument.create();
  const rf = await rp.embedFont(StandardFonts.Helvetica);
  const pg = rp.addPage([400, 400]);
  pg.drawText("Normal line mail top@example.com", { x: 40, y: 340, size: 12, font: rf });
  pg.drawText("Rotated PAN ABCDE1234F here", { x: 330, y: 60, size: 12, font: rf, rotate: degrees(90) });
  const rotatedPage = rp.addPage([400, 300]); rotatedPage.setRotation(degrees(90));
  rotatedPage.drawText("Page rotated attr phone +91 98765 43210", { x: 30, y: 150, size: 12, font: rf });
  writeFileSync(dir + "rotated.pdf", await rp.save());

  const wbT = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wbT, XLSX.utils.aoa_to_sheet([
    ["Quarterly client report"], [""],
    ["Client Name", "Mobile", "Amount"],
    ["Anita Desai", 9876543210, 1500],
    ["Vikram Rathore", 9123456780, 2500],
  ]), "Report");
  XLSX.writeFile(wbT, dir + "titlerow.xlsx");
  XLSX.writeFile(wbT, dir + "legacy.xls", { bookType: "biff8" });

  writeFileSync(dir + "empty.txt", "");
  writeFileSync(dir + "blank.txt", "   \n\n  ");
  writeFileSync(dir + "bad.docx", Buffer.from("this is not a zip file at all"));
  writeFileSync(dir + "UPPER.TXT", "Mail me: shout@example.com");
  writeFileSync(dir + "old.doc", Buffer.from("legacy"));
}

// ---- password-protected fixtures (password for all: "correct-horse") ----
// The Office sources are deliberately large: msoffcrypto-tool 6.0.0 mis-writes
// the OLE container when the encrypted package is small (<=4096 bytes), so a
// tiny fixture would come out undecryptable. Real Word/Excel files are rarely
// that small. The python step asserts a decrypt round-trip, failing loudly.
{
  const big = [];
  for (let i = 0; i < 120; i++) big.push(`Record ${i}: contact Priya Nair on +91 98765 43210 or priya.nair${i}@example.com. PAN ABCDE1234F.`);
  const zb = new JSZip();
  zb.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package/relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zb.file("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zb.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${big.map((t) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`).join("")}</w:body></w:document>`);
  writeFileSync(dir + "locked-src.docx", await zb.generateAsync({ type: "uint8array" }));

  const rows = [["Client Name", "Email", "Phone", "Note"]];
  for (let i = 0; i < 200; i++) rows.push([`Test Person ${i}`, `person${i}@example.com`, `98765${String(10000 + i)}`, `PAN ABCDE1234F ref ${i}`]);
  const wbL = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wbL, XLSX.utils.aoa_to_sheet(rows), "Clients");
  XLSX.writeFile(wbL, dir + "locked-src.xlsx");

  const pyOut = execFileSync("python", ["-"], {
    cwd: dir,
    input: `
from pypdf import PdfReader, PdfWriter
r = PdfReader("sample.pdf")
w = PdfWriter()
for p in r.pages:
    w.add_page(p)
w.encrypt("correct-horse")
with open("locked.pdf", "wb") as f:
    w.write(f)
assert PdfReader("locked.pdf").is_encrypted
print("locked.pdf ok")

import io
import msoffcrypto
for src, out in (("locked-src.docx", "locked.docx"), ("locked-src.xlsx", "locked.xlsx")):
    with open(src, "rb") as fin:
        off = msoffcrypto.OfficeFile(fin)
        off.load_key(password="correct-horse")
        with open(out, "wb") as fout:
            off.encrypt("correct-horse", fout)
    with open(out, "rb") as fin:
        back = msoffcrypto.OfficeFile(fin)
        assert back.is_encrypted, out
        back.load_key(password="correct-horse")
        buf = io.BytesIO()
        back.decrypt(buf)
        assert buf.getvalue()[:2] == b"PK", out + " did not round-trip"
        print(out, "ok, encrypted bytes:", len(open(out, "rb").read()))
`,
  });
  console.log(String(pyOut));
}

// ---- OCR fixtures: a fake document drawn as pixels (all invented data) ----
// PIL draws the words so their pixel boxes are known for the e2e black-box
// check; node then embeds the picture into a scanned PDF (no text layer), a
// text PDF (text layer + the picture) and a .docx (word/media/ + drawing).
{
  const pyDraw = execFileSync("python", ["-"], {
    cwd: dir,
    input: `
from PIL import Image, ImageDraw, ImageFont
import json
W, H = 1600, 1000
img = Image.new("RGB", (W, H), "white")
d = ImageDraw.Draw(img)
import os
ttf = "C:/Windows/Fonts/arial.ttf" if os.path.exists("C:/Windows/Fonts/arial.ttf") else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
big = ImageFont.truetype(ttf, 56)
small = ImageFont.truetype(ttf, 44)
lines = [
    ("Rohan Mehta", big),
    ("PAN QWERT1234Y", big),
    ("Phone +91 98111 22233", big),
    ("rohan.mehta@example.com", small),
    ("Flat 4C Seaside, Mumbai 400050", small),
]
PII_WORDS = {"QWERT1234Y", "+91", "98111", "22233", "rohan.mehta@example.com"}
words = []
y = 90
for text, f in lines:
    x = 90
    space = d.textlength(" ", font=f)
    for w in text.split(" "):
        bb = d.textbbox((x, y), w, font=f)
        d.text((x, y), w, font=f, fill="black")
        words.append({"text": w, "box": bb, "pii": w in PII_WORDS})
        x = bb[2] + space
    y += 150 if f == big else 130
img.save("ocr-doc.png")
img.save("ocr-doc.jpg", quality=95)
with open("ocr-doc.expected.json", "w") as fh:
    json.dump({"width": W, "height": H, "words": words}, fh)
print("ocr-doc.png/jpg ok,", len(words), "words")
`,
  });
  console.log(String(pyDraw));

  const { readFileSync } = await import("node:fs");
  const ocrPng = readFileSync(dir + "ocr-doc.png");
  const ocrExpected = JSON.parse(readFileSync(dir + "ocr-doc.expected.json", "utf8"));

  // scanned.pdf: the picture full-bleed, no text layer at all.
  {
    const doc = await PDFDocument.create();
    const img = await doc.embedPng(ocrPng);
    const s = 0.5; // 1600x1000 px -> 800x500 pt page
    const page = doc.addPage([img.width * s, img.height * s]);
    page.drawImage(img, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
    writeFileSync(dir + "scanned.pdf", await doc.save());
  }

  // textimage.pdf: a real text layer plus the same picture embedded.
  {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([595, 842]);
    page.drawText("Contact Rohan Mehta at rohan.mehta@example.com for details.", { x: 50, y: 780, size: 12, font });
    page.drawText("Our office handles tax filings every quarter.", { x: 50, y: 756, size: 12, font });
    const img = await doc.embedPng(ocrPng);
    const draw = { x: 48, y: 300, w: 500, h: (500 * img.height) / img.width };
    page.drawImage(img, { x: draw.x, y: draw.y, width: draw.w, height: draw.h });
    writeFileSync(dir + "textimage.pdf", await doc.save());
    writeFileSync(
      dir + "textimage.expected.json",
      JSON.stringify({ page: { w: 595, h: 842 }, draw, img: { w: img.width, h: img.height }, words: ocrExpected.words }),
    );

    // formimage.pdf: the same picture nested inside a Form XObject (how pasted
    // scans usually arrive), drawn at the same rect as textimage.pdf.
    const pyForm = execFileSync("python", ["-"], {
      cwd: dir,
      input: `
from pypdf import PdfWriter
from pypdf.generic import DictionaryObject, NameObject, ArrayObject, NumberObject, DecodedStreamObject
from pypdf.filters import FlateDecode
from PIL import Image
img = Image.open("ocr-doc.png").convert("RGB")
W, H = img.size
writer = PdfWriter()
page = writer.add_blank_page(595, 842)
# DecodedStreamObject stores raw bytes in _data; pre-encode them so the
# declared /FlateDecode filter matches what is written.
enc = DecodedStreamObject()
enc._data = FlateDecode.encode(img.tobytes())
enc.update({NameObject("/Type"): NameObject("/XObject"), NameObject("/Subtype"): NameObject("/Image"),
    NameObject("/Width"): NumberObject(W), NameObject("/Height"): NumberObject(H),
    NameObject("/ColorSpace"): NameObject("/DeviceRGB"), NameObject("/BitsPerComponent"): NumberObject(8),
    NameObject("/Filter"): NameObject("/FlateDecode")})
img_ref = writer._add_object(enc)
form = DecodedStreamObject()
form.set_data(b"/Im1 Do")
form.update({NameObject("/Type"): NameObject("/XObject"), NameObject("/Subtype"): NameObject("/Form"),
    NameObject("/BBox"): ArrayObject([NumberObject(0), NumberObject(0), NumberObject(1), NumberObject(1)]),
    NameObject("/Resources"): DictionaryObject({NameObject("/XObject"): DictionaryObject({NameObject("/Im1"): img_ref})})})
form_ref = writer._add_object(form)
content = DecodedStreamObject()
content.set_data(b"BT /F1 12 Tf 50 780 Td (Filed by the regional office on request.) Tj ET\\nq 500 0 0 312.5 48 300 cm /Fm1 Do Q")
content_ref = writer._add_object(content)
page[NameObject("/Resources")] = DictionaryObject({
    NameObject("/Font"): DictionaryObject({NameObject("/F1"): DictionaryObject({NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"), NameObject("/BaseFont"): NameObject("/Helvetica")})}),
    NameObject("/XObject"): DictionaryObject({NameObject("/Fm1"): form_ref})})
page[NameObject("/Contents")] = content_ref
with open("formimage.pdf", "wb") as f:
    writer.write(f)
print("formimage.pdf ok")
`,
    });
    console.log(String(pyForm));
  }

  // picture.docx: one text paragraph plus the picture in word/media/.
  {
    const W3 = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
    const WP = 'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"';
    const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
    const PIC = 'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
    const cx = 4572000, cy = Math.round((cx * ocrExpected.height) / ocrExpected.width);
    const z3 = new JSZip();
    z3.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
    z3.file("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
    z3.file("word/_rels/document.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/ocr.png"/></Relationships>`);
    z3.file(
      "word/document.xml",
      `<?xml version="1.0"?><w:document ${W3} ${R} ${WP} ${A} ${PIC}><w:body>` +
        `<w:p><w:r><w:t xml:space="preserve">Write to rohan.mehta@example.com about the filing.</w:t></w:r></w:p>` +
        `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="1" name="Picture 1"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="ocr.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>` +
        `</w:body></w:document>`,
    );
    z3.file("word/media/ocr.png", ocrPng);
    writeFileSync(dir + "picture.docx", await z3.generateAsync({ type: "uint8array" }));
  }
  console.log("ocr fixtures written");
}
