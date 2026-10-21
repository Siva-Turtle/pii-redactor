# Private Redactor

Drop in a **PDF, Word, Excel, CSV, text or Markdown** file → get back a copy with names, phone numbers,
emails, ID numbers, addresses and dates hidden. **Everything runs on your own computer, inside the browser.
Files are never uploaded**, and the page is locked (via a Content-Security-Policy) so it cannot contact any
other website.

## For everyone: how to use it

**Easiest — open the shared link** (ask whoever set this up; see "Hosting" below). Nothing to install.

**Or run it from a download:**

| Your computer | Do this |
|---|---|
| **Windows** | Download the ZIP → right-click → *Extract All* → double-click **`Start-Windows.bat`** |
| **Mac** | Download the ZIP → double-click it → right-click **`Start-Mac.command`** → *Open* (first time only) |
| **Linux** | Extract, then run `./start-linux.sh` |

A browser tab opens. Then:

1. **Drop your files** on the page (or click it to choose).
2. Wait for **Done** (the first file takes a few extra seconds while the AI wakes up).
3. Click **Download redacted file** (or **Download all as ZIP**).

Keep the black start-up window open while you work; close it to stop. Mac/Linux need Python 3 (already on most
machines; the start file tells you if it is missing). Windows needs nothing extra.

> **Always glance over the result before sharing it.** No automatic tool catches everything — see
> "What it can and cannot do".

## What gets hidden

Two layers work together, and both are local:

1. **Pattern layer** (`js/patterns.js`, ported from the CRM's `backend/utils/piiMasking.js`) — emails, UPI IDs,
   phone numbers, PAN, Aadhaar, GSTIN, IFSC, US SSN, card numbers, long account numbers, IP addresses, and
   dates (birth dates double as passwords on Form 16s and bank statements; there is an option to keep dates).
2. **AI layer** (`js/ai.js`) — [Cactus Needle 3](https://cactuscompute.com/needle), a ~35 MB model running via
   WebAssembly, finds **names** and **postal addresses**. Plus cheap deterministic cues that work even with the AI
   off: `Mr./Dr. X`, `Dear X`, sign-offs (`Regards, X`), `spouse X`, `Name: X`. Every name found is hidden
   *everywhere* in that file, including first-name-only mentions.
3. **Spreadsheets/CSV:** columns whose header says *name, email, phone, mobile, DOB, address, PAN, Aadhaar,
   account no…* are hidden whole; free-text columns go through the two layers above.

| File | What you get back |
|---|---|
| `.txt` `.md` | same file, `[NAME]` `[PHONE]` … in place of each hit |
| `.csv` | same file; quoting, leading zeros and delimiters preserved |
| `.xlsx` `.xls` | `.xlsx`; cell comments and hyperlinks removed; colours/fonts may be simplified |
| `.docx` | formatting preserved; author metadata, comment authors and `mailto:` link targets cleared |
| `.pdf` | pages redrawn with **solid black boxes**; the original text layer is dropped, so nothing can be copied out from under a box |

## What it can and cannot do (please read)

- **Needle is a tool-calling model, not a purpose-built PII/NER model.** We drive it with one narrow tool per
  question ("find a person", "find an address") because that was far more reliable than several at once. In our
  tests it found names well in ordinary sentences but is **not guaranteed** to catch every name — unusual names,
  names in all-caps lists, or names in cluttered text can slip through. A company/organisation question performed
  poorly, so organisations are *not* hidden.
- Patterns are exact; the AI is probabilistic. Treat the output as a strong first pass, then skim it.
- **Scanned PDFs / pictures** (no selectable text) can't be read. PDFs like this are rejected with a message
  rather than returned unredacted. Text inside images embedded in Word/PDF files is not read.
- **Over-redaction is deliberate**: long digit runs and dates are hidden even when harmless, and a name is hidden
  wherever it appears.
- The AI pass is capped at 600 sections per file (≈ 1 s each); beyond that the patterns still cover the whole
  file and you are told so.
- Redacted PDFs are images (bigger, not searchable). Redacted `.xlsx` loses some styling.

## Hosting it for teammates (one time, ~2 minutes)

The repo includes a GitHub Pages workflow. In the repo: **Settings → Pages → Source: “GitHub Actions”**, then push
to `main`. Share the page URL. (Pages sites are public by default; on GitHub Enterprise you can restrict them to
your org. The site contains no data — files only ever stay in each person's browser.)

## For developers

```
index.html        UI (single page, locked-down CSP)
js/patterns.js    regex layer → spans
js/redactor.js    combines layers; learns names once per file, applies everywhere
js/ai.js          Needle sessions (person / address), grounding-checked
js/handlers.js    one handler per file type
js/csv.js         exact-fidelity CSV parser/writer
vendor/           everything the page loads (pdf.js, SheetJS, JSZip, pdf-lib, Needle wasm + 35 MB weights)
serve.py/.ps1/.sh tiny localhost servers behind the Start-* files
tools/update-vendor.sh   re-fetch vendor/ (pins the model revision + SHA-256)
```

```bash
node test/unit.mjs                         # pattern/redactor/CSV tests (no browser)

# end-to-end (needs Playwright + Chromium): generates fake-data fixtures, drives the real page
node test/make-fixtures.mjs
python3 serve.py --no-browser &            # http://localhost:8731
node test/e2e.cjs http://localhost:8731/   # all formats, AI on
node test/e2e.cjs http://localhost:8731/ mixed.pdf && node test/pixel-check.cjs   # PDF boxes fully cover PII
```

Why a local server at all? Browsers refuse to run WebAssembly workers from a double-clicked `file://` page, so
the Start files serve the folder on `http://localhost` (this computer only).
Licenses of bundled components: see `THIRD-PARTY-NOTICES.md`.
