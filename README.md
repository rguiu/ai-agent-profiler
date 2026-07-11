# ai-agent-profiler — live UI demo (gh-pages)

Static, read-only clone of the profiler dashboard, served by GitHub Pages so you
can explore real captured sessions without running the tool.

Sample data: two DeepSeek / opencode `iterative-fix-plus` benchmark sessions
(a baseline and its optimize run). Local paths and credentials are redacted;
raw request/response bodies are stripped (the message-pile view is preserved).

- **Live:** enable Pages on this branch (root) → https://rguiu.github.io/ai-agent-profiler/
- **Regenerate:** run the profiler, then `BASE=http://localhost:8299 node generate.mjs`
  (writes `data/*.json` at the repo root).
- **Source UI:** `app.js` mirrors the live `web/app.js`; only `api()` is shimmed
  to read `data/*.json`.

This branch is a build artifact — do not merge it into `main`.
