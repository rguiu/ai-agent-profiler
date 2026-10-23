# Plan: profiling opencode and Claude Code through Ollama

Goal: `aap run ollama claude|opencode|pi` captures, parses and analyses a full agent
session with the same fidelity we already have for Claude Code on Anthropic.

Status legend: **done** (merged on `feat/run-ollama-launch-agents`), **verify** (built,
not yet confirmed against a real run), **todo**.

## 1. How each agent reaches the proxy

| Agent    | Launch                                                        | Reaches proxy via                     | Wire format                                     |
| -------- | ------------------------------------------------------------- | ------------------------------------- | ----------------------------------------------- |
| claude   | `claude` with `ANTHROPIC_BASE_URL=<proxy>/<sid>/ollama-cloud` | URL prefix (session id in path)       | Anthropic Messages, to ollama.com               |
| opencode | `ollama launch opencode --model M -- --standalone`            | `OLLAMA_HOST=<proxy>`, no path prefix | OpenAI-compatible `/v1/chat/completions`        |
| pi       | `ollama launch pi --model M`                                  | `OLLAMA_HOST=<proxy>`, no path prefix | unknown until verified (`/v1/*` or `/api/chat`) |

Claude is the only agent with a per-session URL. opencode and pi send bare `/api/*` and
`/v1/*` paths, so the proxy attributes them to the **single active ollama session**
(`state.activeOllamaSession`, set when the session registers with `meta.ollama=1`).

## 2. What is already in place

- **done** `aap run ollama [--model M] <claude|pi|opencode> [args]`, model picker with local +
  cloud models, hidden API-key prompt (only used to list cloud models).
- **done** Proxy answers `HEAD /` (the ollama CLI liveness probe) when `[providers.ollama]` is set.
- **done** Proxy routes `/api/*` **and** `/v1/*` to the `ollama` provider
  (fixes `No provider route for "/v1/chat/completions"` seen with opencode).
- **done** opencode is started with `--standalone`; otherwise it attaches to a shared
  `opencode serve --service` that keeps the config of whoever started it and ignores the
  model and routing of the current launch.
- **done** Parser already understands OpenAI-format and Ollama-native responses
  (`parseOpenAI`, `parseOllama` in `src/parse/parse.ts`).
- **done** `config.example.toml` has `[providers.ollama]`; `[providers.ollama-cloud]` is built in.

## 3. Work needed

### 3.1 Confirm capture end to end (verify)

1. `aap serve`, then `aap run ollama --model <m> opencode`, send one prompt.
2. `aap sessions` shows the session with `provider=ollama`, `launcher=ollama-launch`.
3. `aap parse` then `aap sessions`/`aap export`: tokens in/out, cache reads, tool calls non-empty.
4. Repeat for `pi` and note which endpoint it actually uses; extend routing only if it is
   something other than `/api/*` or `/v1/*`.

Exit criterion: one opencode session with at least one tool call shows tokens, tool calls
and cost in the dashboard.

### 3.2 Attribution when more than one session runs (todo)

`activeOllamaSession` is one slot, so two concurrent `aap run ollama opencode|pi` runs
(or a run plus `ollama-cli`) mix their traffic, and the last session to register wins.
Options, cheapest first:

1. Document it and warn on `aap run` if another ollama session is active.
2. Route by `Host` header: launch with `OLLAMA_HOST=http://<sid>.localhost:<port>`
   (`*.localhost` resolves to loopback), and have `parseRoute` take the session from the
   host. Needs a check that the ollama CLI, opencode and pi all keep the host verbatim.
3. One ephemeral proxy port per session.

Recommendation: ship 1 now, prototype 2.

### 3.3 Pricing and model names (todo)

- Cost needs `[pricing."<model>"]` keyed by the model string **as the agent sends it**
  (e.g. `deepseek-v4-pro:0813-cloud`, not the ollama.com listing name `deepseek-v4-pro:0813`).
- Add an `aap` helper or doc step: run once, read the model from `aap sessions`, add pricing.
- Decide what "price" means for Ollama cloud (subscription, not per token). Probably report
  tokens and leave cost empty unless the user configures equivalent rates.

### 3.4 Analysis parity (todo, after 3.1)

Check each analysis layer against opencode traffic rather than assuming Claude shapes:

- Tool names: opencode uses its own set (`bash`, `read`, `edit`, `grep`, ...). Confirm the
  tool-call extraction, shell-command classification (`src/analyze/commands.ts`) and
  repeated-read recommendations (`src/recommend/`) pick them up.
- Request kinds (`docs/REQUEST-KINDS.md`): opencode title-generation and summary requests
  differ from Claude Code's. Confirm they are not all classed as main-loop turns.
- Message-stack breakdown: OpenAI-format `messages[]` with `role: system|tool`.
- Cache reads: Ollama cloud and DeepSeek report cached tokens differently; the parser
  handles OpenAI `prompt_tokens_details.cached_tokens`, check what ollama returns.
- Transcript import: `aap import` supports opencode; confirm it joins to the proxy session
  (needs the opencode session id or cwd + time window).

### 3.5 Make opencode routing consistent (todo)

- Plain `aap run opencode` routes through `OPENCODE_CONFIG_CONTENT`, which the shared
  background service also ignores. Pass `--standalone` there too (or warn when
  `opencode serve --service` is running).
- Both paths should end up with the same session metadata keys, so dashboards and
  `aap compare` can pair an opencode run with a Claude run.

### 3.6 Claude Code parity (todo)

- Today `aap run ollama claude` sets env itself and does not use `ollama launch claude`.
  Decide: keep (full control, per-session URL, tier pinning) or switch to
  `ollama launch claude` for consistency. Recommendation: keep, since it has the only
  reliable per-session attribution.
- Keep Anthropic-only behaviours off for ollama: `ENABLE_TOOL_SEARCH` and the keep-alive
  ping are skipped, `CLAUDE_CODE_AUTO_MODE_SERVER=0` is set.

### 3.7 Tests (todo)

- Fake ollama daemon in tests serving `/api/tags`, `/api/show`, `/v1/chat/completions`
  (stream and non-stream); drive the proxy and assert capture + attribution.
- Parser fixtures from one real opencode and one real pi session (redacted).
- Regression test that `aap run ollama opencode` builds `... -- --standalone` (exists).

### 3.8 Benchmarks (todo)

`benchmarks/agents.toml` has an `ollama` adapter for Claude only. Add opencode
(`ollama launch opencode --model M -- --standalone run --auto`) and a matching
validation entry so the same task can be compared across agents and models.

### 3.9 Docs (todo)

README section exists. Add: the `--standalone` rationale, the single-active-session
limitation, the `:cloud` / `-cloud` model naming rule (inferred, unverified for every
model), and a troubleshooting list (`No provider route`, `something went wrong`,
free model started instead of the chosen one).

## 4. Known risks

- Model name mapping to the daemon (`name:cloud` vs `name-cloud`) is inferred from a few
  names; some models may need typing by hand.
- Behaviour of `ollama launch` can change between releases; we depend on `--model`,
  `--` passthrough and `OLLAMA_HOST` being honoured.
- Request bodies may include prompts and file contents; the existing redaction only covers
  `authorization` and `x-api-key` headers. Review before sharing traces from cloud models.

## 5. Suggested order

1. 3.1 verify opencode and pi end to end (blocks everything else).
2. 3.5 `--standalone` for plain opencode, 3.2 option 1 warning.
3. 3.4 analysis parity fixes driven by what 3.1 shows.
4. 3.3 pricing, 3.7 tests, 3.8 benchmark adapter, 3.9 docs.
5. 3.2 option 2 (host-based session routing) if concurrent runs matter.
