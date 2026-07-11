// Controlled probe of DeepSeek's context-cache mechanics. No fixture task — we
// only care what `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` do when
// we mutate the request in specific ways. Settles H1 (position-independent block
// caching) vs H2 (strict token-prefix-from-0).
//
// Run: tsx benchmarks/cache-probe.ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const auth = JSON.parse(
  readFileSync(join(homedir(), ".local/share/opencode/auth.json"), "utf8"),
) as { deepseek: { key: string } };
const KEY = auth.deepseek.key;
const MODEL = "deepseek-chat";
const URL = "https://api.deepseek.com/chat/completions";

interface Usage {
  prompt_tokens: number;
  prompt_cache_hit_tokens: number;
  prompt_cache_miss_tokens: number;
  completion_tokens: number;
}

type Msg = { role: string; content: string };

async function call(messages: Msg[], label: string): Promise<Usage> {
  const res = await fetch(URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      max_tokens: 1,
      temperature: 0,
    }),
  });
  if (!res.ok)
    throw new Error(`${label}: HTTP ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { usage: Usage };
  const u = json.usage;
  console.log(
    `${label.padEnd(34)} prompt=${String(u.prompt_tokens).padStart(6)}  hit=${String(u.prompt_cache_hit_tokens).padStart(6)}  miss=${String(u.prompt_cache_miss_tokens).padStart(5)}`,
  );
  return u;
}

// Distinct, sizeable blocks so cache units (64 tokens) are clearly exceeded.
const block = (tag: string, n: number): string =>
  Array.from(
    { length: n },
    (_, i) => `${tag} line ${i} lorem ipsum dolor sit amet consectetur`,
  ).join("\n");

const SYS = block("SYSTEM", 120);
const A = block("ALPHA", 120);
const B = block("BRAVO", 120);
const C = block("CHARLIE", 120);
const D = block("DELTA", 120);

const base: Msg[] = [
  { role: "system", content: SYS },
  { role: "user", content: A },
  { role: "assistant", content: B },
  { role: "user", content: C },
  { role: "assistant", content: D },
];

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  console.log(`\nDeepSeek cache mechanics probe (${MODEL})\n${"─".repeat(64)}`);

  // 1. Warm the cache with the base prompt (twice — first is a cold write).
  await call(base, "1a. base (cold write)");
  await pause(1500);
  await call(base, "1b. base repeat (expect full hit)");
  await pause(1500);

  // 2. Append a NEW block at the tail. Prefix unchanged → head should hit.
  const appended: Msg[] = [
    ...base,
    { role: "user", content: block("ECHO", 120) },
  ];
  await call(appended, "2. append tail (expect prefix hit)");
  await pause(1500);

  // 3. Edit an EARLY message (the first user block A → A'). Everything after
  //    should miss under H2; under H1 unrelated later blocks could still hit.
  const editedEarly: Msg[] = [...base];
  editedEarly[1] = { role: "user", content: block("ALPHA-X", 120) };
  await call(editedEarly, "3. edit early msg (H2: all miss)");
  await pause(1500);

  // 4. REMOVE a middle block (drop C). Under H2, cache holds up to the removal
  //    point (SYS,A,B) then misses D. Under H1, D could still hit by itself.
  const removedMiddle: Msg[] = [base[0]!, base[1]!, base[2]!, base[4]!];
  await call(removedMiddle, "4. remove middle block C");
  await pause(1500);

  // 5. REORDER blocks (swap A and C) keeping identical content. Strict prefix
  //    (H2) → miss after the swap point. Position-independent (H1) → still hit.
  const reordered: Msg[] = [base[0]!, base[3]!, base[2]!, base[1]!, base[4]!];
  await call(reordered, "5. reorder A<->C (H2: miss)");

  console.log(`${"─".repeat(64)}`);
  console.log("Interpretation:");
  console.log("  - #2 hit ~= base size → prefix caching works.");
  console.log("  - #3/#5 hit small → STRICT PREFIX (H2): position matters.");
  console.log(
    "  - #3/#5 hit large → POSITION-INDEPENDENT (H1): blocks cache anywhere.",
  );
  console.log("  - #4 hit ~= SYS+A+B → confirms prefix-up-to-removal (H2).");
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
