# Third-party components (all bundled in `vendor/`, no network needed at runtime)

| Component | Use | License |
|---|---|---|
| [Cactus Needle 3](https://huggingface.co/Cactus-Compute/needle3) weights + WASM engine | finds names and addresses | Apache-2.0 |
| [cactus-needle](https://github.com/afshinm/cactus-needle) (browser wrapper, community package) | loads Needle in a Web Worker | Apache-2.0 |
| [pdf.js](https://github.com/mozilla/pdf.js) | reads PDF text and draws pages | Apache-2.0 |
| [pdf-lib](https://github.com/Hopding/pdf-lib) | writes the redacted PDF | MIT |
| [JSZip](https://github.com/Stuk/jszip) | opens/saves .docx and builds the ZIP download | MIT (dual-licensed MIT/GPLv3) |
| [SheetJS CE](https://github.com/SheetJS/sheetjs) | reads/writes .xlsx | Apache-2.0 |
| [@noble/hashes](https://github.com/paulmillr/noble-hashes) (SHA-512 only, bundled as `vendor/noble-crypto.min.mjs`) | password-to-key derivation for protected Office files | MIT |
| [@noble/ciphers](https://github.com/paulmillr/noble-ciphers) (AES-CBC only, same bundle) | decrypts protected Office files | MIT |
| [Fraunces](https://github.com/undercase/Fraunces) (500 latin woff2, `vendor/fonts/fraunces-500.woff2` via [@fontsource/fraunces](https://github.com/fontsource/font-files)) | display font for the heading | OFL-1.1 |
| [Inter](https://github.com/rsms/inter) (400/500/600 latin woff2, `vendor/fonts/inter-*.woff2` via [@fontsource/inter](https://github.com/fontsource/fontsource)) | text font for the UI | OFL-1.1 |

The regular-expression layer in `js/patterns.js` is ported from the Turtle CRM's `backend/utils/piiMasking.js`.
