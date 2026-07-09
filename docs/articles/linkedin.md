# I cut my AI coding agent costs by 72% with a 200-line proxy

AI coding agents are expensive. Not because of the output they generate — that's cheap. Because they resend your entire conversation history to the LLM on every single request.

Think about it: by turn 30 of a debugging session, the model is still paying to read files you opened on turn 3. Files you've since edited. Files that haven't been relevant for 20 turns. Every one of those tokens costs money.

I built a transparent proxy that rewrites request bodies before they hit the LLM. It doesn't change how the agent works — it just removes the waste:

- **Stale results** older than 6 turns → replaced with one-line summaries
- **Duplicate tool calls** (re-reading the same unchanged file) → short stubs
- **Re-reads** of files you just wrote → suppressed entirely
- **Tool definitions** → canonicalised for better prompt-cache hits

Ran a controlled benchmark against the same bug-fixing task (7 planted bugs, 48 tests) with two agents:

**Claude Code (Bedrock):** $2.88 → $0.99 (-66%)
**OpenCode (DeepSeek):** $1.27 → $0.36 (-72%)

Both found all 7 bugs. The optimized runs actually caught *more* edge cases — cleaner context gave the models headroom to spot subtle issues the bloated baseline context obscured.

Wall time improved 25-29% too. Less data = faster round-trips.

The kicker: this works with any OpenAI-compatible agent. Claude Code, OpenCode, Cursor — the proxy is agent-agnostic. One flag to enable (`--optimize`), zero changes to your workflow.

If your team is burning API credits on stale context, this is the lowest-effort cost optimization you'll make this year.

Open source: github.com/rguiu/ai-agent-profiler

#AI #DevTools #LLM #CostOptimization #SoftwareEngineering
