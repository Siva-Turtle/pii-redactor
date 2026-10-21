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

## What gets hidden (finance-focused)

Two layers work together, and both are local:

1. **Pattern layer** (`js/patterns.js`, grown from the CRM's `backend/utils/piiMasking.js`). Exact formats:
   **PAN, Aadhaar, phone, email**, UPI IDs, GSTIN, TAN, IFSC, NSDL demat IDs (`IN300123 10234567`), voter ID,
   credit/debit cards (incl. Amex), US SSN, 15–18-digit account numbers, IP addresses, and dates (birth dates
   double as passwords on Form 16s and statements; there is an option to keep dates).
   **Labelled values** are caught by their label, whatever their format: `a/c`, `account no`, `savings`,
   `loan`, `cheque`, `routing`, `demat`, `DP ID`, `client ID`, `folio`, `policy`, `PRAN`, `UAN`, `CKYC`,
   `passport`, `Aadhaar`, `SSN`, `card`, and `password / PIN / OTP / CVV is …`.
2. **AI layer** (`js/ai.js`) — [Cactus Needle 3](https://cactuscompute.com/needle), a ~35 MB model running via
   WebAssembly. For every sentence it is asked narrow questions (only the relevant ones): *person name*,
   *address*, *bank / demat / folio / policy / loan number*, *government or tax ID*, *password / PIN / OTP /
   username*, plus a catch-all **`find_pii`** ("any other personal or sensitive detail") that must **return the
   exact quote as written in the document**. It finds what patterns cannot: an unlabelled `LIC/0034/998877`, a
   plain-word password, a name in prose, an address.
   - **Ask until sure.** Each sentence is re-checked in a loop that only stops after **two consecutive runs find
     nothing new** (hard cap: 12 runs). Needle is deterministic, so asking the same question twice would just repeat
     the answer; consecutive runs therefore use two *different phrasings* of each question, and whatever a run found
     is blanked out of the text before the next run, so it can surface anything the earlier runs were hiding behind.
   - **Exact quotes only.** An answer is accepted only if it appears in the sentence; the text actually stored is the
     document's own spelling, so find-and-replace works. Answers from the catch-all are additionally typed by shape
     and dropped unless convincing (names must be Capitalised words, numbers must contain digits, whole sentences or
     lowercase phrases are ignored).
   - Everything found is then hidden **everywhere** in that file. Cheap deterministic name cues also work with the
     AI off: `Mr./Dr. X`, `Dear X`, `Regards, X`, `spouse X`, `Name: X`.
   - **Speed:** thorough mode costs roughly 10 seconds per paragraph (about 2 minutes for a dozen lines on a
     laptop CPU), so the AI pass is time-boxed to 10 minutes per file and you are told if it ran out. *Options →
     Thorough check* can be unticked for a single quicker pass.
3. **Spreadsheets/CSV:** columns whose header says *name, email, phone, DOB, address, PAN, Aadhaar, account,
   demat, folio, policy, password…* are hidden whole; other cells go through the two layers above.

| File | What you get back |
|---|---|
| `.txt` `.md` | same file, `[NAME]` `[PHONE]` … in place of each hit |
| `.csv` | same file; quoting, leading zeros and delimiters preserved |
| `.xlsx` `.xls` | `.xlsx`; cell comments and hyperlinks removed; colours/fonts may be simplified |
| `.docx` | formatting preserved; author metadata, comment authors and `mailto:` link targets cleared |
| `.pdf` | pages redrawn with **solid black boxes**; the original text layer is dropped, so nothing can be copied out from under a box |

## What it can and cannot do (please read)

- **Needle is a tool-calling model, not a purpose-built PII/NER model.** We drive it with one narrow tool per
  question because that was far more reliable than several at once. It tends to over-report (safe for
  redaction) and sometimes labels a hit with the wrong type, but it is **not guaranteed** to catch everything —
  unusual names, all-caps lists, or cluttered text can slip through. A company/organisation question performed
  poorly, so organisations are *not* hidden. Fixed-format finance IDs rely on the pattern layer, which is exact.
- Patterns are exact; the AI is probabilistic. Treat the output as a strong first pass, then skim it.
- **Scanned PDFs / pictures** (no selectable text) can't be read. PDFs like this are rejected with a message
  rather than returned unredacted. Text inside images embedded in Word/PDF files is not read.
- **Over-redaction is deliberate**: long digit runs and dates are hidden even when harmless, and a name is hidden
  wherever it appears.
- The AI pass is time-boxed (10 minutes per file); beyond that the patterns still cover the whole file and you
  are told so. Big spreadsheets will usually hit this, so their header-based column hiding matters most.
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
node test/make-fixtures.mjs                # also writes finance.txt, a finance-heavy sample
python3 serve.py --no-browser &            # http://localhost:8731
node test/e2e.cjs http://localhost:8731/   # all formats, AI on
node test/e2e.cjs http://localhost:8731/ mixed.pdf && node test/pixel-check.cjs   # PDF boxes fully cover PII
```

Why a local server at all? Browsers refuse to run WebAssembly workers from a double-clicked `file://` page, so
the Start files serve the folder on `http://localhost` (this computer only).
Licenses of bundled components: see `THIRD-PARTY-NOTICES.md`.
