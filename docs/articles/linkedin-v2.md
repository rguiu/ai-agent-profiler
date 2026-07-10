# I cut my AI coding agent's bill by up to 78% — and it got *smarter*

Here's something easy to miss about AI coding agents: the model has no memory. So on every single turn, the agent re-sends the *entire* conversation back to the LLM. The whole growing pile.

By turn 30 of a debugging session, you're still paying to re-send files you opened on turn 3 — files you've already edited, files that stopped being relevant 20 turns ago. And most of the bill isn't the model's answers. It's this stale paperwork, mailed over and over.

[article3.png]
> *The profiler on one session: the same ~21K of tool definitions and ~24K of system prompt re-sent on every request, context growing 34× across just a handful of turns.*

So I built a small transparent proxy that trims the pile before it goes out. It doesn't change what the agent does — only what it sends:

→ Stale file reads (already edited) → one-line summaries
→ Unused tool definitions → dropped after the agent settles on its 3-4 tools
→ Re-reads of files just written → skipped
→ Duplicate calls → collapsed to stubs

[article2.png]
> *The profiler flags exactly what's wasteful — repeated reads, re-sent tool definitions, runaway context growth — then the optimizer trims it automatically.*

I ran a controlled benchmark — same task (9 planted bugs + 3 method stubs, hidden edge-case tests), fresh code each time, two different agents:

Claude Code: $2.88 → $0.68  (-77%)
OpenCode (DeepSeek): $1.27 → $0.28  (-78%)

Same task. All tests passing. Roughly three-quarters of the cost, gone.

The part that genuinely surprised me: quality went *up*, not down. Both agents found every planted bug — but the optimized runs caught *extra* edge cases the bloated runs missed. Less noise in the context, more room to actually think.

And it wasn't just cheaper — it was leaner. One agent finished the whole task in half the requests: 38 turns down to 18.

A few honest caveats:
• These are my own experimental results on one benchmark. One fixture, a handful of runs.
• Short sessions barely benefit — the wins come from long, iterative work.
• I'd love for others to poke holes in it. Run it on your own tasks, tell me where it breaks.

It's open source and works with any OpenAI/Anthropic-compatible agent (Claude Code, OpenCode, Cursor…). One flag: `--optimize`. Zero workflow changes.

If your team is quietly burning credits on stale context, I think this is worth 10 minutes of your time. I build tooling for AI coding agents, and this is the experiment I keep coming back to — so if you run it on your own tasks, I'd genuinely like to see your numbers. Post them or DM me; I'll compare notes.

github.com/rguiu/ai-agent-profiler

#AI #DevTools #LLM #CostOptimization #SoftwareEngineering
