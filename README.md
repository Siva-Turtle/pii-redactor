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
   - **Speed:** Needle runs in one worker per CPU core (up to 6), and every question for every sentence is
     queued across them. Measured: asking N questions at once costs the same as asking one, so the finance sample
     (12 lines, 81 model calls) takes ~33 s on a 4-core machine, down from 137 s with two workers. The AI pass is
     time-boxed to 10 minutes per file, and you are told if it ran out. *Options → Thorough check* can be unticked
     for a single, quicker pass. Sentences with nothing worth asking about (no names, digits or `@`) are skipped.
3. **Your own list.** *Options → "Always hide these exact words or lines"* takes comma-separated items such as
   `Project Falcon, Acme Wealth Pvt Ltd`. They are hidden everywhere, ignoring capitals and extra spaces, and
   win over every other rule. They show up as `[REDACTED]`.
4. **Spreadsheets/CSV:** columns whose header says *name, email, phone, DOB, address, PAN, Aadhaar, account,
   demat, folio, policy, password…* are hidden whole; other cells go through the two layers above.

| File | What you get back |
|---|---|
| `.txt` `.md` | same file, `[NAME]` `[PHONE]` … in place of each hit |
| `.csv` | same file; quoting, leading zeros and delimiters preserved |
| `.xlsx` `.xls` | `.xlsx`; cell comments and hyperlinks removed; colours/fonts may be simplified |
| `.docx` | formatting preserved; author metadata, comment authors and `mailto:` link targets cleared |
| `.pdf` | pages redrawn with **solid black boxes**; the original text layer is dropped, so nothing can be copied out from under a box |

## Redaction report

Every finished file gets a collapsed **“What was hidden (N items)”** section: a compact table of
location, type, the exact original quote, and who found it. A **“Download report (.csv)”** button on each
card downloads the full list; **“Download all reports (.csv)”** next to *Download all as ZIP* downloads one
combined CSV for every file.

> **Keep the report private.** The report contains the ORIGINAL sensitive text that was hidden. Never send it
> along with the redacted file. The downloadable CSV starts with the same warning. Reports live in memory
> only (never stored, never sent anywhere) and are deliberately **not** included in *Download all as ZIP*.

CSV columns: `file, location, page, type, quote, found_by, detail` (UTF-8 with BOM for Excel). Cells starting
with `= + - @` (or tab/CR) get a leading apostrophe so Excel can't run them as formulas. `found_by` is one of
`script` (pattern rule in `detail`), `script: name cue` (e.g. “Dear X”), `script: column header` (header text in
`detail`), `you` (your manual-list entry in `detail`), `needle` (Cactus Needle question/run/variant in `detail`,
e.g. `account, run 0, variant 0`; the first run that found a term is recorded, then the term is hidden everywhere).

Locations by file type (Word files don't store page numbers, so no pages are invented):

| File | Location |
|---|---|
| PDF | `page N, line M` (page is 1-based; `page` column holds N) |
| XLSX/XLS | `Sheet!Cell` (e.g. `Clients!B7`) |
| CSV | `row N, column "Header"` (row is the file row, 1-based) |
| TXT/MD | `line N` |
| DOCX | `body, paragraph N`, `body, table T, row R, cell C`, `header`/`footer`/`footnote`/`endnote`/`comment` paragraph, `hyperlink`, `field` |

In *“Only remove the password”* mode the report is empty (with a note), because nothing was hidden.

## Password-protected files

Drop in a locked **PDF, `.docx` or `.xlsx`** and the card asks for its password instead of failing. Type it
and press Enter (or click **Unlock**): the file is unlocked on this computer and goes through the normal
checks, and the download is a plain unprotected file. A wrong password just says so — try again. While a
file waits for its password, other files keep processing; nothing queues up behind it.

*Options → "Only remove the password (don't hide anything)"* returns the unlocked file exactly as it is,
with nothing hidden. For PDFs the pages are re-drawn as pictures (this tool's PDF output is always images),
so the text can no longer be selected — the card says so.

Very old protection can't be opened: Word/Excel 97–2003 files, and the pre-2013 "standard" Office
encryption. The card tells you to re-save the file without a password and try again. The password itself
is never saved, sent, logged or kept: it lives only until the file is processed, then the box is cleared.

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
node test/unit.mjs                         # pattern/redactor/CSV/Office-crypto tests (no browser)

# end-to-end (needs Playwright + Chromium): generates fake-data fixtures, drives the real page
node test/make-fixtures.mjs                # also writes finance.txt, a finance-heavy sample
python3 serve.py --no-browser &            # http://localhost:8731
node test/e2e.cjs http://localhost:8731/   # all formats, AI on
node test/e2e.cjs http://localhost:8731/ mixed.pdf && node test/pixel-check.cjs   # PDF boxes fully cover PII
PW=$(npm root -g)/playwright NOAI=1 node test/e2e.cjs http://localhost:8731/ locked.pdf locked.docx locked.xlsx sample.txt
                                           # password workflow: lock card, wrong-password retry, unlock, unencrypted downloads
PW=$(npm root -g)/playwright NOAI=1 ONLYUNLOCK=1 node test/e2e.cjs http://localhost:8731/ locked.pdf locked.docx locked.xlsx
                                           # "only remove the password" mode
```

Why a local server at all? Browsers refuse to run WebAssembly workers from a double-clicked `file://` page, so
the Start files serve the folder on `http://localhost` (this computer only).
Licenses of bundled components: see `THIRD-PARTY-NOTICES.md`.
