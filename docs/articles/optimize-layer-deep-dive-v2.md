# Your AI Coding Agent Is Paying to Re-Read the Same Files Over and Over

**How a small transparent proxy cut the cost of a real bug-fixing task by up to 77% — without changing a single thing about how the agent works.**

---

## First, what the tool actually is

Before talking about savings, it helps to understand where this thing lives.

An AI coding agent — Claude Code, OpenCode, Cursor, whatever you use — is really just a program that talks to a language model over the network. It reads a file, sends the contents to the model, gets a suggestion back, edits the file, runs the tests, sends the results back, and so on. Every one of those steps is an HTTP request going out to the provider.

The AI Agent Profiler (`aap`) sits in the middle of that conversation, like a meter on a water pipe. The agent thinks it's talking straight to the provider; the provider thinks it's hearing straight from the agent. In reality every request passes through the profiler first.

In its normal mode the profiler is completely hands-off. It looks at each request, writes down what it saw — how many tokens, which tools, which files, how long it took — and passes it along byte for byte. Nothing is changed. It's a read-only observer that finally lets you _see_ what your agent is doing and where your money is going.

That alone is useful. But once you can see the waste, the obvious next question is: can we remove it? That's the second part of the story.

## The thing nobody tells you about agents

Here's the part that surprises most people.

A language model has no memory. It doesn't "remember" your last message. So to keep a conversation going, the agent has to re-send the _entire_ history on every single turn. The whole pile:

```
[ System:    "You are a coding assistant. Here are your 30 tools..." ]
[ User:      "Fix the failing tests in this project." ]
[ Assistant: "Let me read the scheduler file." ]
[ Tool:      <the full 2 KB contents of scheduler.js> ]
[ Assistant: "Now let me check the queue." ]
[ Tool:      <the full 1.5 KB contents of priority-queue.js> ]
[ Assistant: "Running the tests now." ]
[ Tool:      <200 lines of test output> ]
... and on, and on ...
```

Every time the agent wants to say one new sentence, it mails the model this _entire growing stack_ again. Turn 2 re-sends turn 1. Turn 20 re-sends turns 1 through 19. Turn 50 re-sends everything that ever happened.

And here's the kicker. Most of that pile is **dead weight**.

Think about how you'd actually fix a bug. You open a file to understand it. You read it, you get what you need, you make your change. Once you've edited that file, the _original_ version you read ten minutes ago is worthless — it's not even accurate anymore. But the agent keeps mailing that stale original to the model on every turn for the rest of the session. You are literally paying, over and over, to re-send a snapshot of a file that no longer exists.

The same goes for tool definitions. When the agent starts up it tells the model "here are the 30 tools you can use, with full descriptions." That block is big. And it gets re-sent every single turn — even if the agent only ever ends up using three of those tools the entire session.

This is why long sessions get so expensive. It's not the model thinking hard. It's the bill for re-reading the same stale paperwork, thousands of times.

## Why this hits your wallet specifically

Two things make it worse than it sounds.

**Input is where the money is.** Almost all the cost of an agent session is the stuff you _send in_, not the stuff the model writes back. A long session might send two or three _million_ input tokens while the model writes only a few thousand words back. The output is a rounding error. The input pile is the whole bill.

**It compounds.** More history means a bigger pile. A bigger pile means slower requests. Slower requests mean longer sessions. Longer sessions mean an even bigger pile. It's a snowball, and it rolls downhill straight into your credit card.

## The fix: trim the pile before it goes out

Because the profiler already sits in the middle of every request, it's in the perfect spot to do something clever. Flip on the **optimize layer** and, right before each request leaves for the provider, it quietly cleans up the outgoing pile.

The important word is _quietly_. It never touches the model's reply. It never changes what the agent does next. It only edits what the agent _sends_, and only in ways the agent can't tell apart from the original. From the agent's point of view, nothing happened. From your bill's point of view, a lot happened.

A few simple rules do most of the work:

- **Prune stale results.** A file the agent read fifteen turns ago and has since edited? Replace that big block with a one-line note: _"[read scheduler.js earlier — 1.2 KB]"_. The model doesn't need the stale copy; it already acted on it.
- **Drop unused tool definitions.** If, after ten turns, the agent has only ever touched three of its thirty tools, stop mailing the descriptions of the other twenty-seven every single turn.
- **Skip pointless re-reads.** If the agent just wrote a file two turns ago, and now wants to read it back, don't bother — it already knows what's in there.
- **Collapse duplicates.** If the agent ran the exact same command five times, keep the first result in full and turn the rest into short stubs.

None of this is magic. It's just refusing to pay the same bill twice.

## The experiment: fix seven bugs, count the money

To put real numbers on it, we ran a controlled test. We built a JavaScript project with seven modules, planted nine deliberate bugs plus three stubbed methods, and wired up ~54 tests. Hidden edge-case tests graded at verify time. The task handed to the agent was blunt: fix everything, implement the stubs, and pass all tests.

Then we ran that same task with the profiler in the middle, comparing a plain passthrough against the optimize layer, across two different agents. Every run started from a clean copy of the code. Success is measured by both visible and hidden tests — no partial credit.

## What happened

**Claude Code (on Bedrock):**

```
                   plain      optimized
  ─────────────────────────────────────────
  Input tokens     1.83M      329K       -82%
  Cost             $2.88      $0.68      -77%
  Bugs found       7          9          +2
  All tests pass   yes        yes
```

**OpenCode (on DeepSeek):**

```
                   plain      optimized
  ─────────────────────────────────────────
  Input tokens     2.88M      821K       -71%
  Cost             $1.27      $0.36      -72%
  Requests         38         19         -50%
  Bugs found       7          8          +1
  All tests pass   yes        yes
```

Read those cost lines again. Same task, same result, roughly three-quarters of the bill gone.

## The best part: it didn't get dumber, it got sharper

You'd expect that stripping context out would hurt the quality. It did the opposite.

Both agents found all seven planted bugs in every run — that never wavered. But the _optimized_ runs actually found **more** issues than the plain ones. Claude spotted two extra edge cases the bloated run missed: a subtle timing bug in how the cache broke ties, and a scheduler that could leave a task starved forever. OpenCode caught an extra deadlock.

The reason is intuitive once you sit with it. A cleaner, shorter pile is easier to reason about — for a model just like for a person. When the model isn't wading through fifteen stale copies of files that no longer exist, it has more attention left over to notice the tricky stuff. Less noise, sharper thinking.

There was even a behavioral surprise. Given a leaner context, OpenCode did the whole job in _half_ the requests — it saw clearly what still needed fixing and batched its work instead of re-reading files it had already touched. Cleaner input, less flailing.

## When it won't do much for you

Honesty first: this isn't a miracle for every situation.

If your sessions are short — a quick "explain this function" or "fix this typo" — there's barely any pile to trim, so there's barely any savings. The optimizer earns its keep on the long, grinding sessions: multi-file debugging, refactors, iterative fix-and-test loops. That's exactly where costs spiral today, which is the point.

It also does less on tiny single-file projects, where the agent genuinely does need to re-read the one file that keeps changing. The big wins come from big, re-read-heavy work — which, conveniently, is most real work.

## Try it — it's one flag

The whole thing is open source, and turning on the savings takes a single flag:

```
aap serve --optimize
```

Or make it permanent:

```toml
[optimize]
enabled = true
```

The defaults are deliberately cautious, and even so the benchmark shows a 72–77% cost cut with no drop in quality. Because it's a transparent proxy, it works with any agent that talks to an OpenAI- or Anthropic-compatible endpoint — Claude Code, OpenCode, Cursor, whatever you're running. You don't rewrite anything. You point your agent at the proxy and get on with your day.

If your team is quietly bleeding API credits into stale context, this is about the cheapest fix you'll find all year.

Project and full benchmark reports: [github.com/rguiu/ai-agent-profiler](https://github.com/rguiu/ai-agent-profiler)
