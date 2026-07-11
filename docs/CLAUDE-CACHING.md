# Anthropic Claude Prompt Caching — Implementation Guide

This document describes how to structure requests to Claude to maximize prompt cache efficiency.

## Mental Model

Claude prompt caching is **explicit**. The client chooses where cached prefixes end by placing `cache_control` markers in the request.

A cache checkpoint tells Claude:

> "Everything before this point is stable enough to cache and reuse."

On future requests, if the content before a checkpoint is byte/token identical, Claude can reuse the cached computation instead of recomputing it.

The cache always represents a **prefix of the prompt**. It never caches arbitrary middle sections independently.

---

# Cache Breakpoints

A request may contain multiple cache breakpoints.

Typical structure:

```text
System Prompt

Tool Definitions

Repository Knowledge

cache_control

Project Summary

cache_control

Conversation Summary

cache_control

Recent Conversation

Current User Message
```

Each breakpoint creates another possible reusable prefix.

Claude attempts to reuse the **longest matching cached prefix**.

For example:

```
Checkpoint A
    System
    Tools

Checkpoint B
    System
    Tools
    Repository Summary

Checkpoint C
    System
    Tools
    Repository Summary
    Conversation Summary
```

If only the conversation summary changes:

* Checkpoint C becomes invalid.
* Checkpoint B is still reusable.
* Claude resumes processing from Checkpoint B.

---

# Matching Rules

Cache reuse requires that everything before the selected checkpoint be identical.

This means identical:

* token sequence
* ordering
* whitespace (after provider tokenization)
* tool definitions
* system prompt
* JSON schemas
* examples
* summaries

Changing any earlier content invalidates checkpoints after that location.

---

# Multiple Checkpoints

Using multiple checkpoints is generally preferable to using only one large checkpoint.

Example:

```
System
Tools
CACHE

Repository Summary
CACHE

Conversation Summary
CACHE

Live Conversation
```

Benefits:

* Repository updates do not invalidate the System/Tools cache.
* Conversation-summary updates do not invalidate repository caching.
* Only the minimum amount of prompt must be recomputed.

---

# Recommended Prompt Layers

Organize prompts from least frequently changing to most frequently changing.

Suggested ordering:

Layer 1

* System prompt
* Global instructions
* Stable policies

Layer 2

* Tool definitions
* Function schemas
* MCP descriptions

Layer 3

* Repository documentation
* Project architecture
* Coding conventions
* Long-term memory

Layer 4

* Project summary

Layer 5

* Conversation summary

Layer 6

* Recent messages

Layer 7

* Current user message

Each layer should change significantly less frequently than the one below it.

---

# Stable Sections

Good candidates for cached prefixes include:

* system prompts
* coding guidelines
* organization policies
* API documentation
* repository summaries
* dependency graphs
* architectural documentation
* tool schemas
* MCP descriptions
* long-term project memory

These usually remain unchanged across many requests.

---

# Frequently Changing Sections

Avoid placing frequently changing content before cache checkpoints.

Examples:

* timestamps
* request IDs
* token counts
* execution statistics
* temporary notes
* progress bars
* rotating examples
* ephemeral metadata

Even a tiny modification before a checkpoint prevents reuse of that checkpoint.

---

# Conversation Management

Do not repeatedly rewrite the beginning of the conversation.

Prefer this lifecycle:

```
Stable Summary
↓

Append messages

↓

Append messages

↓

Append messages

↓

Conversation becomes large

↓

Generate new summary

↓

Replace summary once

↓

Begin appending again
```

This minimizes how often cached prefixes change.

---

# Summarization Strategy

Instead of continuously editing summaries:

Bad:

```
Summary v1
Summary v2
Summary v3
Summary v4
```

on every request.

Better:

```
Summary

append

append

append

append

compact

New Summary

append

append
```

One cache invalidation during compaction is much cheaper than invalidating the cache every turn.

---

# Tool Definitions

Tool definitions are excellent cache candidates because they usually remain static.

Examples:

* function schemas
* MCP server descriptions
* JSON schemas
* parameter documentation

Only modify them when necessary.

---

# Repository Knowledge

Repository context should be separated from conversation context.

Example:

```
System

Tools

CACHE

Repository Index

Repository Summary

Architecture

CACHE

Conversation Summary

CACHE

Recent Messages
```

Repository updates are generally much less frequent than conversation updates.

---

# Long-Term Memory

Persistent memory should be isolated from live conversation.

Example:

```
System

Tools

CACHE

Long-term Memory

CACHE

Conversation Summary

CACHE

Recent Conversation
```

This allows conversation summaries to evolve without invalidating the more stable long-term memory.

---

# Current User Message

The current user message should always be placed last.

This naturally maximizes cache reuse because only the newest input changes every request.

---

# General Design Principles

1. Order prompt sections from most stable to least stable.

2. Insert cache checkpoints after major stable sections.

3. Keep system prompts highly stable.

4. Keep tool definitions stable.

5. Separate repository knowledge from conversation state.

6. Separate long-term memory from short-term conversation.

7. Append new conversation rather than rewriting old conversation whenever possible.

8. Compact conversation only periodically.

9. Regenerate summaries infrequently.

10. Never include volatile metadata before cache checkpoints.

11. Make each checkpoint correspond to a meaningful semantic layer of information.

12. Prefer several medium-sized stable checkpoints over a single monolithic checkpoint, enabling partial cache reuse when later layers change.

---

# Example High-Performance Layout

```
System Prompt

Global Instructions

CACHE

Tool Definitions

MCP Definitions

CACHE

Repository Summary

Architecture

Coding Standards

Long-Term Memory

CACHE

Conversation Summary

CACHE

Recent Conversation

Current User Message
```

This structure minimizes recomputation while allowing independent evolution of repository knowledge, long-term memory, and conversation state. It maximizes the opportunity for Claude to reuse previously computed prompt prefixes across successive requests while keeping the live conversational context flexible.
</content>
