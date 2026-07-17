import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openSearchStore,
  toFtsQuery,
  SNIPPET_START,
  SNIPPET_END,
  type SearchStore,
} from "./search-store.js";
import type { ChunkDraft, ChunkSource } from "./extract.js";

const dirs: string[] = [];

function tmpStore(): SearchStore {
  const dir = mkdtempSync(join(tmpdir(), "aap-search-"));
  dirs.push(dir);
  return openSearchStore(dir);
}

afterEach(() => {
  let dir: string | undefined;
  while ((dir = dirs.pop())) rmSync(dir, { recursive: true, force: true });
});

function source(requestId: string, sessionId = "sess-1"): ChunkSource {
  return {
    requestId,
    sessionId,
    ts: `2026-07-17T10:00:0${requestId.slice(-1)}.000Z`,
    model: "claude-sonnet-4",
    requestKind: "main",
    repo: "github.com/acme/widget",
    cwd: "/home/dev/widget",
    client: "claude",
  };
}

function draft(
  uid: string,
  text: string,
  overrides: Partial<ChunkDraft> = {},
): ChunkDraft {
  return {
    chunkUid: uid,
    kind: "prompt",
    role: "user",
    toolName: null,
    filePath: null,
    isError: false,
    contentHash: `hash-${text}`,
    text,
    ...overrides,
  };
}

describe("toFtsQuery", () => {
  it("quotes bare terms", () => {
    expect(toFtsQuery("zmq port race")).toBe('"zmq" "port" "race"');
  });

  it("preserves quoted phrases", () => {
    expect(toFtsQuery('"advisory locks" store')).toBe(
      '"advisory locks" "store"',
    );
  });

  it("keeps trailing-star prefix queries", () => {
    expect(toFtsQuery("TCPSto*")).toBe('"TCPSto"*');
  });

  it("neutralizes FTS operators and stray syntax", () => {
    expect(toFtsQuery("a AND b OR c NOT d")).toBe(
      '"a" "AND" "b" "OR" "c" "NOT" "d"',
    );
    expect(toFtsQuery("col:val (x)")).toBe('"col:val" "(x)"');
  });

  it("returns empty string for whitespace", () => {
    expect(toFtsQuery("   ")).toBe("");
  });
});

describe("SearchStore", () => {
  it("indexes and finds chunks by full text", () => {
    const store = tmpStore();
    store.indexRequest("req-1", source("req-1"), [
      draft("req-1:0:0", "we fixed the ZMQ port race with advisory locks"),
      draft("req-1:1:0", "unrelated content about parsing"),
    ]);
    const hits = store.search({ query: "zmq race" });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.request_id).toBe("req-1");
    expect(hits[0]?.snippet).toContain(`${SNIPPET_START}ZMQ${SNIPPET_END}`);
  });

  it("is idempotent per request", () => {
    const store = tmpStore();
    const drafts = [draft("req-1:0:0", "hello world")];
    expect(store.indexRequest("req-1", source("req-1"), drafts)).toBe(1);
    expect(store.indexRequest("req-1", source("req-1"), drafts)).toBe(1);
    expect(store.status().chunks).toBe(1);
    expect(store.search({ query: "hello" })).toHaveLength(1);
  });

  it("dedupes repeated history across requests in a session", () => {
    const store = tmpStore();
    store.indexRequest("req-1", source("req-1"), [
      draft("req-1:0:0", "same user prompt"),
    ]);
    store.indexRequest("req-2", source("req-2"), [
      draft("req-2:0:0", "same user prompt"),
      draft("req-2:1:0", "new assistant answer", { kind: "response" }),
    ]);
    expect(store.status().chunks).toBe(2);
    const hits = store.search({ query: "prompt" });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.request_id).toBe("req-1");
  });

  it("keeps identical content from different sessions separate", () => {
    const store = tmpStore();
    store.indexRequest("req-1", source("req-1", "sess-a"), [
      draft("req-1:0:0", "duplicated text"),
    ]);
    store.indexRequest("req-9", source("req-9", "sess-b"), [
      draft("req-9:0:0", "duplicated text"),
    ]);
    expect(store.search({ query: "duplicated" })).toHaveLength(2);
  });

  it("filters by kind, tool, file, errors, and session", () => {
    const store = tmpStore();
    store.indexRequest("req-1", source("req-1"), [
      draft("req-1:0:0", "Edit src/store.py fix the race", {
        kind: "tool_call",
        toolName: "Edit",
        filePath: "src/store.py",
        contentHash: "h1",
      }),
      draft("req-1:1:0", "NullPointerException in race handler", {
        kind: "tool_result",
        toolName: "bash",
        isError: true,
        contentHash: "h2",
      }),
      draft("req-1:2:0", "the race is discussed here", { contentHash: "h3" }),
    ]);

    expect(store.search({ query: "race", kinds: ["tool_call"] })).toHaveLength(
      1,
    );
    expect(store.search({ query: "race", tool: "Edit" })).toHaveLength(1);
    expect(store.search({ query: "race", file: "store.py" })).toHaveLength(1);
    expect(store.search({ query: "race", errorsOnly: true })).toHaveLength(1);
    expect(store.search({ query: "race", session: "sess-1" })).toHaveLength(3);
    expect(store.search({ query: "race", session: "nope" })).toHaveLength(0);
  });

  it("supports filter-only browse mode without a query", () => {
    const store = tmpStore();
    store.indexRequest("req-1", source("req-1"), [
      draft("req-1:0:0", "an edit", {
        kind: "tool_call",
        toolName: "Edit",
        filePath: "src/a.ts",
        contentHash: "h1",
      }),
      draft("req-1:1:0", "a prompt", { contentHash: "h2" }),
    ]);
    const hits = store.search({ query: "", file: "src/a.ts" });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.tool_name).toBe("Edit");
  });

  it("does not throw on hostile query input", () => {
    const store = tmpStore();
    store.indexRequest("req-1", source("req-1"), [
      draft("req-1:0:0", "plain text"),
    ]);
    for (const evil of ['"unbalanced', "NEAR(", "a:b:c", "((((", '""']) {
      expect(() => store.search({ query: evil })).not.toThrow();
    }
  });

  it("records failures and reports status", () => {
    const store = tmpStore();
    store.indexRequest("req-1", source("req-1"), [
      draft("req-1:0:0", "content"),
    ]);
    store.markFailed("req-2", "boom");
    const status = store.status();
    expect(status.indexedRequests).toBe(1);
    expect(status.failedRequests).toBe(1);
    expect(status.chunks).toBe(1);
    expect(store.indexedRequestIds()).toEqual(new Set(["req-1", "req-2"]));
  });

  it("deletes a session's chunks and state", () => {
    const store = tmpStore();
    store.indexRequest("req-1", source("req-1", "sess-a"), [
      draft("req-1:0:0", "alpha text"),
    ]);
    store.indexRequest("req-2", source("req-2", "sess-b"), [
      draft("req-2:0:0", "beta text"),
    ]);
    store.deleteSession("sess-a");
    expect(store.search({ query: "alpha" })).toHaveLength(0);
    expect(store.search({ query: "beta" })).toHaveLength(1);
    expect(store.indexedRequestIds()).toEqual(new Set(["req-2"]));
  });

  it("returns full chunk text by uid", () => {
    const store = tmpStore();
    store.indexRequest("req-1", source("req-1"), [
      draft("req-1:0:0", "the full text lives here"),
    ]);
    expect(store.getChunk("req-1:0:0")?.text).toBe("the full text lives here");
    expect(store.getChunk("missing")).toBeNull();
  });
});
