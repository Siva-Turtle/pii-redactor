# Working rules for this repo (Private Redactor)

All implementation work in this repo is carried out by the opencode agent
`opencode-go/muse-spark-1.3-contributor` (run via
`opencode run -m opencode-go/muse-spark-1.3-contributor`). Claude Code only
writes briefs, launches and manages those agents, and reviews their output;
Claude must not write or edit code itself.

Launch an implementation session like this:

```
opencode run -m opencode-go/muse-spark-1.3-contributor --dir /home/user/pii-redactor "<brief>"
```

Never let an opencode run stall unnoticed:

- Launch it in the background with stdin closed (`... "<brief>" < /dev/null`);
  without that it can sit at init waiting for input.
- While it runs, always keep a background `sleep 300` task going so Claude is
  called back every 5 minutes. On each wake, check opencode's own log
  (`~/.local/share/opencode/log/opencode.log`: latest `step=` and timestamp)
  and the working tree, then re-arm the sleep. If there is no new step for
  ~7 minutes, kill it and relaunch with a corrected brief.
- Briefs forbid filesystem-wide searches (`find /`, `find C:`): one froze a run.

Notes for briefs in this repo:

- Static, browser-only tool. Work ONLY inside `/home/user/pii-redactor`;
  never touch `/home/user/Current-CRM-MongoDB`.
- Never run `git commit` / `git push`; leave changes in the working tree.
- No network at runtime: CSP in `index.html` stays
  `script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' blob: data:`.
  New libraries must be permissively licensed (MIT/Apache/BSD) and vendored
  under `vendor/` (see `tools/update-vendor.sh`, `tools/package.json`,
  `THIRD-PARTY-NOTICES.md`).
- Passwords are never stored, logged, or kept after processing.
- Keep the repo's code style (ES modules, small functions, comments say WHY).
- Verify with `node test/unit.mjs` and the Playwright e2e
  (`PW=$(npm root -g)/playwright NOAI=1 node test/e2e.cjs http://localhost:8731/ …`);
  the page is served by `python3 serve.py --no-browser` (port 8731).
- Fixtures are generated, not committed: `node test/make-fixtures.mjs`
  (encrypted ones use sandbox Python tooling: `pypdf`, `msoffcrypto-tool`).
