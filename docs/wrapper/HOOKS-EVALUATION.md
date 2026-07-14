# Evaluation: shell hooks (tool output filtering)

Context: on the `feat/optimize-wave2` branch we added a **shell hook layer** — PATH-based
wrappers in `~/.aap/bin/` that filter tool output before it enters the agent context,
without touching the API request body or the prompt cache. Enabled per session with
`aap run --hooks` (or `AAP_HOOK_MODE=true`), which prepends `~/.aap/bin` to `PATH`.

This doc evaluates (1) the idea and how it compares to
[rtk](https://github.com/rtk-ai/rtk), and (2) how the Risk team could get the most out of
it via a dedicated, project-tuned wrapper plus source-level output reduction.

---

## 1. The idea

### Core insight (sound)

Filter tool output at the **shell level**, before it enters context, **without touching
the API request body**. Our own findings established that request-rewriting destroys the
provider prompt cache (Claude Code re-sends pristine history each turn — see
[`OPEN-QUESTIONS.md`](./OPEN-QUESTIONS.md) #1). Shell hooks sidestep that entirely: they
change what a tool _prints_, so the cache is never a factor. That is the right insight and
the main thing separating this from naive "compress the prompt" approaches.

### Comparison to rtk

We are similar to rtk but deliberately more generic.

| Dimension    | rtk                                                                               | our hooks                                                   |
| ------------ | --------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Interception | Claude Code **native `PreToolUse` hook** rewrites `git status` → `rtk git status` | **PATH shadowing** (`~/.aap/bin` prepended)                 |
| Coupling     | Claude Code specific (hook config)                                                | agent-agnostic — works for opencode, Claude, any subprocess |
| Filtering    | structured: smart-filter, **group**, **dedup**, truncate; 100+ commands           | per-command bash scripts, ~7 commands, mostly `head`/`tail` |
| Claimed win  | 60–90% token reduction on common dev commands                                     | not yet measured per command                                |
| Impl         | single Rust binary, zero deps, <10ms                                              | fork+pipe per call, bash                                    |

**Our edge:** genericness. Because we intercept via PATH rather than a Claude-specific
hook, the layer works for _any_ agent the profiler already proxies (opencode, Claude,
future AISH). That is on-brand for a profiler that is explicitly agent-agnostic.

**Where rtk is ahead:** its filters are **semantic** (group similar items, dedup repeated
lines with counts, preserve the signal). Our current filters are mostly **positional**
(`tail -40`, `head -60`), which is the weak form — a blind `tail` can drop the one line
that mattered. The exceptions are our `node --test` and `npm` filters, which _are_
semantic (strip passing tests, keep failures + diagnostics). Those are the model to
follow.

### Trade-offs of PATH shadowing

The genericness is real and valuable, but PATH shadowing is the riskier mechanism:

- It shadows the binary for **everything** in the subprocess, not just agent-initiated
  calls — including git the agent runs for legitimate reasons where truncation corrupts
  the answer.
- Positional truncation is **lossy in a dumb way** vs. rtk's grouping/dedup.
- It is **invisible**: a wrapped `git log` that misbehaves looks like git misbehaving.

### Shipped bug (now fixed)

Three of the four `git` wrapper branches in `3f18e3e` were non-functional, and `cargo`'s
`test` branch had the same defect. `"$@"` still contained the subcommand, so it was
passed twice:

```bash
diff)  __REAL_BIN__ diff "$@" ...   # $@ still holds "diff" → `git diff diff`
log)   __REAL_BIN__ log ... "$@"    # → `git log ... log`
show)  __REAL_BIN__ show "$@"       # → `git show show`
```

Reproduced with hooks active:

```
$ git diff   → fatal: ambiguous argument 'diff': unknown revision or path...
$ git log    → fatal: ambiguous argument 'log'...
$ git show   → fatal: ambiguous argument 'show'...
$ git status → works (that branch does not forward "$@")
```

This was exactly the "invisible failure" risk: it silently broke git for any hooked
session and looked like a git problem, not a wrapper problem. Fixed by `shift`-ing the
subcommand before forwarding, with a regression test (`src/hook/templates.test.ts`) that
actually **execs each branch** against a real temp repo — the previous tests did not.

### Verdict

Keep the idea — it is worth pursuing, and the genericness is the differentiator. But the
current templates are a proof-of-concept: positional truncation is the weak form of what
rtk does semantically. Lean into the agent-agnostic angle and make the filters semantic
(the `node --test` / `npm` filters already are — they are the model to follow).

---

## 2. Team adoption (kept out of this repo)

How a specific team could deploy semantic filters — including a working prototype and a
pitch doc — is intentionally **not** in this repo. It lives in that team's own harness
repo so nothing team-specific leaks here.

The general, project-independent conclusions:

- **Filters must be semantic, not positional.** Parse the tool's output and keep what the
  agent needs to act (what failed, where, why); drop coverage tables, library-frame
  tracebacks, progress noise. Blind `head`/`tail` can cut the one line that mattered.
- **Native `PostToolUse` beats a proxy for a single-agent team.** Claude Code's
  `PostToolUse` hook can _replace_ tool output via `updatedToolOutput` before it reaches
  context — no proxy, no PATH shadowing, nothing extra to install. The profiler's PATH
  wrappers remain the right tool when you need to be **agent-agnostic**.
- **Reduce at the source where you own the tool** (e.g. pytest config in `pyproject.toml`)
  — version-controlled, benefits humans + CI, no invisible failure mode. Use hooks only
  for tools you can't change.
- **Represent filters as data/config** (`command → filter`), not one bash script per
  command, so the set is easy to extend.
- **Measure, don't guess.** This profiler's tool-result token-amplification metric tells
  you _which_ commands are worth a filter before you write one, and verifies the saving
  after. That measure → optimize → verify loop is the real differentiator over rtk.

---

## Recommended next steps

1. **Fix** the `git`/`cargo` wrapper double-subcommand bug + add per-branch exec tests.
   ✅ Done — `src/hook/templates.test.ts` execs each git branch against a temp repo.
2. **Make the built-in filters semantic** where they are still positional (`grep`, `find`,
   `cat`, `ls`, `git diff/log/show` use `head`/`tail`); the `node`/`npm` test filters show
   the pattern.
3. **Decide** filter representation (manifest/config vs. per-command scripts) before
   scaling past ~7 commands.
