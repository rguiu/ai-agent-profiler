# Vision

AI Agent Profiler exists to help us **understand how coding agents behave** so we can build better agent execution environments.

It is **not** an observability dashboard.
It is **not** an enterprise proxy.
It is **not** an LLM profiler.

Its purpose is to identify inefficiencies in _agent execution_ — excessive tool calls, bloated context, redundant file reads, inefficient interaction patterns — and to turn those observations into evidence that guides the design of better tools, protocols, and runtimes.

> **Measure agent behavior. Discover inefficiencies. Drive better agent design.**

Just as a CPU profiler identifies hotspots in software, AI Agent Profiler aims to identify hotspots in agent execution.

## What it does

The profiler sits as a transparent, read-only proxy between a coding agent (Claude Code, Opencode) and an LLM provider (Anthropic, OpenAI-compatible). It observes, records, and analyses every interaction. It never changes requests.

- **Observe** — capture every request, response, streaming event, error, and timing.
- **Understand** — extract higher-level structure: tool calls, context growth, repeated files, repeated prompts.
- **Measure** — derive metrics: token usage, latency, cost, duplicated context, requests per task.
- **Enable research** — become the foundation for experiments about how agents _should_ be built.

## Guiding principle: record first, analyse later

This is the single most important design constraint, borrowed from profilers like `perf`:

> **Prefer collecting raw, high-fidelity data over implementing complex analyses. If a metric can be derived later from stored traces, store the trace rather than computing everything eagerly.**

This keeps the profiler flexible as our research questions evolve. Avoid premature optimisation and overengineering.

## Questions it should answer

Things humans currently cannot easily answer:

- Why did the agent make 27 requests?
- Why was this file read 15 times?
- Which shell command generated the most tokens?
- Which MCP server reduced prompt size?
- Which context was duplicated?
- Which tools contribute most to cost?
- Which interactions actually helped solve the task?

## Long-term goals

- Discover inefficient tools.
- Benchmark MCP servers rather than LLMs.
- Measure context amplification caused by shell commands.
- Compare plain-text output versus structured output.
- Measure the effectiveness of context compression.
- Design better AI-native tools that minimise token usage.
- Determine which information agents actually consume versus ignore.

## Relationship to AISH

AISH is a future execution environment for coding agents — an AI-native shell, repository-aware tools, token-efficient commands, better context providers, smarter MCP servers, structured outputs instead of text dumps. It is not an assistant.

The profiler exists to generate the evidence that guides AISH.

```
Profiler → Evidence
AISH     → Optimisation
```

No optimisation in AISH should exist because it "sounds like a good idea." Every optimisation should be backed by profiler data.

Candidate AISH capabilities — each with a "hypothesis → profiler metric → baseline → target" slot to fill from benchmark data — are tracked in [`docs/aish-requirements.md`](docs/aish-requirements.md).

## The research-first test

Most features should be evaluated with one question:

> **"Will this help us discover better ways of building coding agents?"**

If the answer is no, it probably belongs in another project. Behaviour-changing features (response caching, becoming an MCP framework, etc.) are out of scope unless they are optional, disabled by default, and justified by measurement.
