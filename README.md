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
| **Mac / Linux** | Extract, then run `./serve.sh` (`Start-Mac.command` / `start-linux.sh` just run it) |

A browser tab opens. Then:

1. **Choose your files** in the file field (click it, or drop files onto it).
2. If a file is password-protected, its row shows a **password box** — type the
   password there (other files keep processing while it waits).
3. Click **Remove PII** and watch the status line. Pressing Enter in a password
   box, or clicking Remove PII again, processes the files that now have a password.
4. Click **Download PII removed File** (one file downloads as that file; two or
   more download as one `pii-removed-files.zip`).
5. Open **Show Identified PIIs** to see everything that was hidden, or download
   the combined report (`.csv`) from inside that section.

Keep the black start-up window open while you work; close it to stop. Mac/Linux need Python 3 (already on most
machines; the start file tells you if it is missing). Windows needs nothing extra.

## First-time setup: download the model

The name/address finder needs a 83 MB model file that is **not** in the
download (kept out to keep the repo light). First run downloads it once
automatically (~83 MB, from Hugging Face, SHA-256 checked). Or fetch it
manually once with:

| Your computer | Command (run inside the extracted folder) |
|---|---|
| **Windows** (PowerShell) | `powershell -ExecutionPolicy Bypass -File tools\fetch-model.ps1` |
| **Mac / Linux** | `bash tools/fetch-model.sh` |

It downloads from Hugging Face and checks the SHA-256. The Start files below
run the same check automatically when the model is missing, and stay offline
once it is there. Without the model the app still works but only the pattern
checks run, and it tells you so.

> **Always glance over the result before sharing it.** No automatic tool catches everything — see
> "What it can and cannot do".

## What gets hidden (finance-focused)

Two layers work together, and both are local:

1. **Pattern layer** (`js/patterns.js`, grown from the CRM's `backend/utils/piiMasking.js`). Exact formats:
   **PAN, Aadhaar, phone, email**, UPI IDs, GSTIN, TAN, IFSC, NSDL demat IDs (`IN300123 10234567`),
   voter ID, credit/debit cards (incl. Amex), US SSN, 15–18-digit account numbers, IP addresses, Emirates IDs
   (Luhn-checked), and dates.
   Dates are always hidden (birth dates double as passwords on Form 16s and statements).
   **Labelled values** are caught by their label, whatever their format: `a/c`, `account no`, `savings`,
   `loan`, `cheque`, `routing`, `demat`, `DP ID`, `client ID`, `folio`, `policy`, `PRAN`, `UAN`, `CKYC`,
   `passport`, `Aadhaar`, `SSN`, `card`, loose `premise/consumer/contract/member/uid/client-code/cif/policy`
   numbers, and `password / PIN / OTP / CVV is …`.
   A **number guard** keeps amounts visible: money-formatted or money-labelled digit runs stay readable
   (nearest label wins: an ID word nearer than a money word still hides).
2. **AI layer** (`js/gliner.js`, `js/gliner-worker.js`) — [GLiNER PII small v1.0](https://huggingface.co/knowledgator/gliner-pii-small-v1.0),
    a purpose-built PII model (83 MB, int8, ModernBERT encoder) running locally via WebAssembly.
    Text is scanned in windows of ~300 characters with **one call per window
    asking for person, address, PAN/folio/phone/email/customer-id/account/passport together**. It finds what patterns cannot: a
    name in prose, an address.
    - **Exact grounding.** An answer is accepted only if it appears in the window; the text actually stored is the
      document's own spelling, so find-and-replace works. Hits are additionally filtered by shape and score
      (threshold 0.4 for all labels; model-hit filter drops generic labels, amounts, dates, ISINs), and
      statement vocabulary (stock names, amounts, dates) is never treated as a name.
    - Everything found is then hidden **everywhere** in that file. Cheap deterministic name cues also work with the
      AI off: `Mr./Dr. X`, `Dear X`, `Regards, X`, `spouse X`, `Name: X`.
    - **Speed:** GLiNER runs in one worker per half CPU core (up to 4), each holding its own model session.
      Measured: ~0.2 s per window (~5 windows/s with 4 workers on the test machine). The AI pass is
    time-boxed to 10 minutes per file, and you are told in the status line if it ran out. Windows with no
    capitalised word, digit run or @ worth checking are skipped without calling the model.
3. **Spreadsheets/CSV:** columns whose header says *name, email, phone, DOB, address, PAN, Aadhaar, account,
   demat, folio, policy, password…* are hidden whole; other cells go through the two layers above.
4. **Batch-wide (one client's bundle):** the files you drop together are learned as one bundle in two passes
   (`Reading file 2 of 5…`, then `Hiding PII in file 2 of 5…`): every string any layer hid in any file is
   searched for in every file. ID-like terms (4+ digits or @) always carry over; other terms only with
   agreement (hidden in ≥30% of the places they appear), so one-off model slips do not spread. A
   **statement-header layer** (`js/statement-header.js`) trusts the investor block (holder name, address
   lines, email, mobile, PAN, folios, client/BO IDs, nominees) with name variants and surname widening for
   family names; **address blocks, end-of-line PIN codes, IDs from file names, OCR misreadings and cut-off
   bank-narration names** are covered too. Security/fund names near an ISIN stay visible.

| File | What you get back |
|---|---|
| `.txt` `.md` | same file, `[NAME]` `[PHONE]` … in place of each hit |
| `.csv` | same file; quoting, leading zeros and delimiters preserved |
| `.xlsx` `.xls` | `.xlsx`; cell comments and hyperlinks removed; colours/fonts may be simplified |
| `.docx` | formatting preserved; author metadata, comment authors and `mailto:` link targets cleared |
| `.pdf` | pages redrawn with **solid black boxes**; the original text layer is dropped, so nothing can be copied out from under a box |

Every redacted file also ends with a short machine-readable notice (`js/notice.js`) telling any LLM that
later reads it that the document went through this tool and asking it to stop and escalate (notify "Siva") if
any PII is still visible. It is real selectable text (a closing page/paragraph/row/sheet depending on the
format), never hidden inside an image.

## Redaction report

Open **Show Identified PIIs** (closed until you open it) to see ONE combined table
for all files: file, location, type, the exact original quote, and who found it.
A **Download report (.csv)** link inside that section downloads the full list
(cap: the on-page table shows the first ~200 rows with a "showing N of M" note).

> **Keep the report private.** The report contains the ORIGINAL sensitive text that was hidden. Never send it
> along with the redacted file. The downloadable CSV starts with the same warning. Reports live in memory
> only (never stored, never sent anywhere) and are deliberately **not** included in the ZIP download.

CSV columns: `file, location, page, type, quote, found_by, detail` (UTF-8 with BOM for Excel). Cells starting
with `= + - @` (or tab/CR) get a leading apostrophe so Excel can't run them as formulas. `found_by` is one of
`script` (pattern rule in `detail`), `script: name cue` (e.g. “Dear X”), `script: column header` (header text in
`detail`), `you` (your manual-list entry in `detail`), `gliner` (GLiNER label/score in `detail`,
e.g. `person, score 0.85`; the first window that found a term is recorded, then the term is hidden everywhere),
`script: batch` (term carried over from another file of the same batch; `detail` names the original layer).

Locations by file type (Word files don't store page numbers, so no pages are invented):

| File | Location |
|---|---|
| PDF | `page N, line M` (page is 1-based; `page` column holds N) |
| XLSX/XLS | `Sheet!Cell` (e.g. `Clients!B7`) |
| CSV | `row N, column "Header"` (row is the file row, 1-based) |
| TXT/MD | `line N` |
| DOCX | `body, paragraph N`, `body, table T, row R, cell C`, `header`/`footer`/`footnote`/`endnote`/`comment` paragraph, `hyperlink`, `field` |

In *“Only remove the password”* mode (backend support in `js/handlers.js`; no
checkbox in the page) the report is empty (with a note), because nothing was hidden.

## Password-protected files

Choose a locked **PDF, `.docx` or `.xlsx`** and its row shows its own password
box (`Password for <file>`) instead of failing. Type the password and press Enter
in the box (or click **Remove PII**): the file is unlocked on this computer and
goes through the normal checks, and the download is a plain unprotected file. A
wrong password marks only that row and the status line says which file it was
for — try again. While a file waits for its password, other files keep
processing; nothing queues up behind it.

Very old protection can't be opened: Word/Excel 97–2003 files, and the pre-2013 "standard" Office
encryption. The status line tells you to re-save the file without a password and try again. The password itself
is never saved, sent, logged or kept: it lives only until the file is processed, then the box is cleared.

## What it can and cannot do (please read)

- **GLiNER is a small zero-shot NER model, not a human reviewer.** It only looks for person names and
  addresses (organisations are *not* hidden), and it is **not guaranteed** to catch everything —
  unusual names, all-caps lists, or cluttered text can slip through. Fixed-format finance IDs rely on the pattern layer, which is exact.
- Patterns are exact; the AI is probabilistic. Treat the output as a strong first pass, then skim it.
- **Scanned PDFs / pictures** (no selectable text) are read with offline OCR (`vendor/tesseract`,
  `js/ocr.js`). It works offline but is slower and may miss faint text — review the output.
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
js/gliner.js      GLiNER sessions (all PII labels in one call per window), grounding-checked
js/handlers.js    one handler per file type
js/csv.js         exact-fidelity CSV parser/writer
js/notice.js      closing LLM notice appended to every redacted file
vendor/           everything the page loads (pdf.js, SheetJS, JSZip, pdf-lib, GLiNER engine + wasm)
models/           GLiNER tokenizer/config files (the 83 MB onnx weights live under vendor/gliner/…,
                   git-ignored — fetch with tools/fetch-model.sh or .ps1, see "First-time setup")
serve.py/.ps1/.sh tiny localhost servers behind the Start-* files
tools/fetch-model.sh (.ps1 on Windows)   download + SHA-256-check the 83 MB model (no npm needed)
tools/update-vendor.sh   re-fetch vendor/ (calls fetch-model.sh for the weights)
```

```bash
node test/unit.mjs                         # pattern/redactor/CSV/Office-crypto tests (no browser)

# end-to-end (needs Playwright + Chromium): generates fake-data fixtures, drives the real page
node test/make-fixtures.mjs                # also writes finance.txt, a finance-heavy sample
python3 serve.py --no-browser &            # http://localhost:8731
node test/e2e.cjs http://localhost:8731/   # all formats, AI on
node test/e2e.cjs http://localhost:8731/ mixed.pdf && node test/pixel-check.cjs   # PDF boxes fully cover PII
PW=$(npm root -g)/playwright NOAI=1 node test/e2e.cjs http://localhost:8731/ locked.pdf locked.docx locked.xlsx sample.txt
                                           # password workflow: password row, wrong-password retry, unlock, unencrypted downloads
```

The visible UI is deliberately one screen with fixed settings (AI on, thorough
check always on, dates hidden, no manual list, `onlyUnlock` off — see the named
constants at the top of `js/app.js`). The removed Options panel, per-file cards
and extra download buttons are commented out in `index.html` and `js/app.js`
(marked "hidden by design"); the backend still supports everything
(`Redactor` manual list, `onlyUnlock` handler paths, per-file report builders —
all unit-tested). To re-enable an option: restore the commented markup in
`index.html`, rewire the commented lines in `js/app.js`, and add the matching
assertions back to `test/e2e.cjs`.

Why a local server at all? Browsers refuse to run WebAssembly workers from a double-clicked `file://` page, so
the Start files serve the folder on `http://localhost` (this computer only).
Licenses of bundled components: see `THIRD-PARTY-NOTICES.md`.
