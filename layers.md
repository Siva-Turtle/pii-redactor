# How Private Redactor finds PII — the layers

Everything below runs inside the browser tab. Files are read from the user's
disk, processed in memory, and downloaded back; nothing is uploaded.

The pipeline has three parts: **read the file**, **find PII** (learn, then
mark), and **write the redacted file**. Each detection layer below names the
code that implements it.

---

## 1. Reading the file

| Layer | What it does | Code |
|---|---|---|
| File handlers | One handler per type: TXT/MD/CSV, XLSX, DOCX, PDF, images. Pulls the text out and later writes redactions back (cell edits, DOCX run edits, PDF black boxes). | `js/handlers.js`, `js/csv.js` |
| Password-protected files | Opens encrypted PDF/Office files with the password the user types. The password is never stored, logged or kept after processing. | `js/office-crypto.js`, `vendor/noble-crypto.min.mjs`, pdf.js |
| OCR (Tesseract) | Reads text inside pictures: images, scanned PDF pages, pictures in DOCX. Maps each word back to its pixel box so it can be blacked out. Fully offline (vendored Tesseract). | `js/ocr.js`, `vendor/tesseract/` |

## 2. Finding PII — pass 1: learn

Pass 1 reads every file in the batch and builds a list of "terms" (names,
IDs, addresses) to hide. Order matters, and is fixed in `Redactor.learn()`.

| # | Layer | What it learns | Code |
|---|---|---|---|
| 1 | Statement header | The investor block at the top of CAS / bank / broker statements: holder name, address lines, email, mobile, PAN, folios, nominees. Values are **trusted** (no second opinion needed). | `js/statement-header.js`, `_learnHeader` |
| 2 | Cue words | Names after "Dear", "Name:", "Client:", "Regards," etc. | `_learnCues` |
| 3 | Regex patterns | Fixed-format identifiers (full list in section 4). A labelled value is learned so its bare repeats are hidden too. | `js/patterns.js`, `_learnPatterns` |
| 4 | Security/fund names | Recognises fund and security names so they are **not** treated as people. | `_learnSecurity`, `_isSecurityName` |
| 5 | Family names | First names of relatives that share a trusted surname. | `_learnFamily` |
| 6 | Address blocks | Lines under a trusted name or salutation heading ("MR. …"), locality lines, stopping at narration lines. | `_learnAddressBlocks` |
| 7 | AI model (Knowledgator GLiNER) | `gliner-pii-small-v1.0`, quantised, run locally in parallel workers. Finds names, addresses and IDs that rules miss. Multi-line hits are split per line. | `js/gliner.js`, `js/gliner-worker.js`, `_learnGliner` |
| 8 | Batch-wide learning | A term found in one file is searched in **every** file of the batch (with name variants and surname widening). AI-only terms need agreement across files; trusted terms skip that check. | `computeGlobals`, `addGlobal`, `deriveAddressParts` |
| 9 | Your own list | Words the user types in the "always hide" box. Always wins. | `parseManual`, `buildManual` |

## 3. Finding PII — pass 2: mark spans

Pass 2 walks each file's text and marks character ranges ("spans") to hide.
Order is fixed in `Redactor.spans()`.

| Layer | What it marks | Code |
|---|---|---|
| Your own list | Every match of the user's words (source `you`). | `spans()` |
| Regex patterns | Every identifier from `js/patterns.js`. | `patterns.js` |
| Propagation | Bare repeats of IDs learned from labelled values. | `_propSpans` |
| Batch globals | Terms learned anywhere in the batch. | `_globalSpans` |
| Trusted values | Header / address-block values, with name variants. | `_trustedSpans` |
| PIN codes | 6-digit Indian PINs after a "PIN/PINCODE" label, at the end of an address line, or inside a mostly-hidden block. | `_pinSpans` |
| Postal codes | 5-digit codes next to a comma/hyphen on an address line. | `_postalSpans` |
| Narration | Payee names inside bank narration (e.g. `UPI/<NAME>/…`). | `_narrationSpans` |
| Concatenated names | Usernames made of a learned name joined together (e.g. `ravimehta`). | `_concatSpans` |
| OCR text | Extra rules for text read from pictures. | `_ocrSpans` |
| Learned terms | AI and cue terms found again in this text, line by line. | `spans()` |
| File names | IDs found in the file name. | `fileNameIds` |

## 4. Regex pattern rules (`js/patterns.js`)

Rules run in priority order; a later rule never overlaps an earlier one.

- **Contact:** EMAIL, UPI handle, PHONE (labelled, 10-digit, Indian mobile, US style)
- **Tax / government:** PAN, TAN, GSTIN, AADHAAR, SSN, Voter ID (EPIC), Emirates ID (Luhn-checked)
- **Banking:** ACCOUNT (labelled, and long unlabelled numbers), IFSC, CARD
- **Investments:** FOLIO, DEMAT (NSDL/CDSL BO ID), POLICY, labelled IDs
- **Network:** IP address
- **Secrets:** the value after password / PIN / OTP / CVV
- **Dates:** toggleable (dates of birth are often used as file passwords)
- **Silent guards** (claim the range so nothing else hides it): ISIN codes, broker/depository and transaction reference numbers

## 5. Guards — what must stay visible

Applied before anything is hidden. These are what keep false alarms down.

| Guard | Rule | Code |
|---|---|---|
| Amounts | Numbers in a money context (currency, decimals, thousand separators, rows/columns about balance, loan, value, EMI, payment…) are never hidden. Merged spans are split around them. | `isAmountVisible`, `findAmountExclusions`, `hasMoneyWord`, `labelAndHeaderAt` |
| Currency codes | INR, USD, AED, ₹, Rs… on their own are never hidden. | `isCurrencyCode` |
| Plain table numbers | ≤7-digit numbers with no ID label nearby are never learned or spread batch-wide. | `computeGlobals`, `_addTerm` |
| Generic words | Stop words and generic terms (for, investor, registered, number, address…) are never learned as names. | `js/common-words.js`: `isGenericNameTerm`, `isCommonWord` |
| Label-only spans | A span made only of label words ("Registered Address", "Policy Number") is dropped. | `isGenericLabelText` |
| AI hit filter | Every AI hit and every line piece of a hit passes the same checks (score, kind, length, amount, generic words, fund names). | `isFilteredModelHit`, `passesModelPieceGate`, `isGenericGlinerStop`, `isFundAdjacent` |
| Span merge | Overlapping spans merge into their union (so no text in between is left visible), then split around amounts. | `spans()` (`addMerged`) |

## 6. Writing the output

| Layer | What it does | Code |
|---|---|---|
| Redaction | Replaces spans in text/cells/DOCX runs, draws black boxes on PDF pages and pictures. | `js/handlers.js`, `apply()` |
| LLM notice | Adds a notice to each output telling an AI reader to stop and flag any PII it finds. | `js/notice.js` |
| Report | A CSV listing what was hidden, its type and which layer found it. | `buildReportCsv` |
| file:// guard | If `index.html` is double-clicked instead of served, shows how to start the app. | `js/guard.js` |
| Offline storage | A service worker (`sw.js`, decision in `js/asset-cache.js`) keeps the heavy `vendor/` + `models/` blobs (GLiNER weights, ONNX wasm, Tesseract files) in Cache Storage after the first visit, with a background conditional revalidation; app code and user documents are never cached. | `sw.js`, `js/asset-cache.js` |

## Security boundary

- The page's Content-Security-Policy (`index.html`) only allows scripts and
  connections to its own origin, so the page cannot send data anywhere else.
- The static host serves files only; it has no endpoint that could receive a
  document.

## Not used by the app

`js/ai.js`, `vendor/needle/` and `vendor/model/needle3.cact` are the old Needle
model path. Nothing in the app loads them; only old test scripts do. The
Vercel deploy leaves them out.
