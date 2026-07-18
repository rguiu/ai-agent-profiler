import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openSearchStore, type SearchStore } from "../search-store.js";
import { importClaudeTranscript, discoverClaudeTranscripts } from "./claude.js";
import { importOpencode, overlapsProxiedSession } from "./opencode.js";

const dirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aap-import-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  let dir: string | undefined;
  while ((dir = dirs.pop())) rmSync(dir, { recursive: true, force: true });
});

function tmpSearch(): SearchStore {
  return openSearchStore(tmpDir());
}

// ---- Claude Code transcripts ----

function writeClaudeTranscript(dir: string): string {
  const sessionId = "6a0f9d3e-1111-2222-3333-444455556666";
  const projectDir = join(dir, ".claude", "projects", "-home-dev-widget");
  mkdirSync(projectDir, { recursive: true });
  const path = join(projectDir, `${sessionId}.jsonl`);
  const lines = [
    { type: "summary", summary: "irrelevant" },
    {
      type: "user",
      uuid: "u1",
      parentUuid: null,
      sessionId,
      cwd: "/home/dev/widget",
      timestamp: "2026-07-10T08:00:00.000Z",
      message: {
        role: "user",
        content: "How do I contact James Mace about the visa?",
      },
    },
    {
      type: "assistant",
      uuid: "a1",
      parentUuid: "u1",
      sessionId,
      cwd: "/home/dev/widget",
      timestamp: "2026-07-10T08:00:05.000Z",
      message: {
        role: "assistant",
        model: "claude-sonnet-4",
        content: [
          { type: "text", text: "Draft a short reconnection email." },
          {
            type: "tool_use",
            id: "tu1",
            name: "Write",
            input: { file_path: "notes/james-mace.md", content: "Hi James..." },
          },
        ],
      },
    },
    {
      type: "user",
      uuid: "u2",
      parentUuid: "a1",
      sessionId,
      cwd: "/home/dev/widget",
      timestamp: "2026-07-10T08:00:06.000Z",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu1",
            content: "saved",
            is_error: false,
          },
        ],
      },
    },
  ];
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n"));
  return path;
}

describe("importClaudeTranscript", () => {
  it("indexes messages from the active path with metadata", () => {
    const home = tmpDir();
    const path = writeClaudeTranscript(home);
    const search = tmpSearch();

    const summary = importClaudeTranscript(path, search, new Set());
    expect(summary.messages).toBe(3);
    expect(summary.chunks).toBeGreaterThan(0);

    const hits = search.search({ query: "james mace" });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.session_id).toBe("6a0f9d3e-1111-2222-3333-444455556666");
    expect(hits[0]?.cwd).toBe("/home/dev/widget");

    const call = search.search({ query: "", file: "james-mace" });
    expect(call).toHaveLength(1);
    expect(call[0]?.tool_name).toBe("Write");

    const result = search.search({ query: "saved", kinds: ["tool_result"] });
    expect(result[0]?.tool_name).toBe("Write");

    search.close();
  });

  it("is incremental: already-imported messages are skipped", () => {
    const home = tmpDir();
    const path = writeClaudeTranscript(home);
    const search = tmpSearch();

    importClaudeTranscript(path, search, new Set());
    const again = importClaudeTranscript(
      path,
      search,
      search.indexedRequestIds(),
    );
    expect(again.messages).toBe(0);
    expect(again.chunks).toBe(0);
    search.close();
  });

  it("discovers transcripts under the projects dir", () => {
    const home = tmpDir();
    writeClaudeTranscript(home);
    expect(discoverClaudeTranscripts(home)).toHaveLength(1);
    expect(discoverClaudeTranscripts(tmpDir())).toHaveLength(0);
  });
});

// ---- opencode DB ----

function writeOpencodeDb(dir: string): string {
  const dbPath = join(dir, "opencode.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT,
                          time_created INTEGER, time_updated INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT,
                          time_created INTEGER, data TEXT);
    CREATE TABLE part (id INTEGER PRIMARY KEY, message_id TEXT,
                       session_id TEXT, data TEXT);
  `);
  db.prepare(`INSERT INTO session VALUES (?, ?, ?, ?, ?)`).run(
    "ses_jobs1",
    "/home/dev/jobs",
    "London staff role via James Mace (visa)",
    Date.parse("2026-07-10T07:56:18.000Z"),
    Date.parse("2026-07-10T08:30:00.000Z"),
  );
  db.prepare(`INSERT INTO message VALUES (?, ?, ?, ?)`).run(
    "msg_1",
    "ses_jobs1",
    Date.parse("2026-07-10T07:56:20.000Z"),
    JSON.stringify({ role: "user" }),
  );
  db.prepare(`INSERT INTO message VALUES (?, ?, ?, ?)`).run(
    "msg_2",
    "ses_jobs1",
    Date.parse("2026-07-10T07:56:30.000Z"),
    JSON.stringify({
      role: "assistant",
      model: { providerID: "deepseek", modelID: "deepseek-chat" },
    }),
  );
  const part = db.prepare(
    `INSERT INTO part (message_id, session_id, data) VALUES (?, ?, ?)`,
  );
  part.run(
    "msg_1",
    "ses_jobs1",
    JSON.stringify({
      type: "text",
      text: "I want to reconnect with a recruiter in London",
    }),
  );
  part.run("msg_2", "ses_jobs1", JSON.stringify({ type: "step-start" }));
  part.run(
    "msg_2",
    "ses_jobs1",
    JSON.stringify({
      type: "reasoning",
      text: "Considering how to phrase the visa point",
    }),
  );
  part.run(
    "msg_2",
    "ses_jobs1",
    JSON.stringify({ type: "text", text: "Here is a draft for James." }),
  );
  part.run(
    "msg_2",
    "ses_jobs1",
    JSON.stringify({
      type: "tool",
      tool: "bash",
      callID: "c1",
      state: {
        status: "error",
        input: { command: "ls drafts" },
        error: "ls: drafts: No such file or directory",
      },
    }),
  );
  db.close();
  return dbPath;
}

describe("importOpencode", () => {
  it("indexes titles, text, reasoning, and tool parts with provider metadata", () => {
    const dbPath = writeOpencodeDb(tmpDir());
    const search = tmpSearch();

    const summary = importOpencode(search, new Set(), { dbPath });
    expect(summary.sessions).toBe(1);
    expect(summary.messages).toBe(2);

    const title = search.search({ query: "james mace visa" });
    expect(title.length).toBeGreaterThan(0);
    expect(title[0]?.kind).toBe("title");
    expect(title[0]?.session_id).toBe("ses_jobs1");

    const response = search.search({ query: "draft for James" });
    expect(response[0]?.provider).toBe("deepseek");
    expect(response[0]?.model).toBe("deepseek-chat");

    const err = search.search({ query: "drafts", errorsOnly: true });
    expect(err).toHaveLength(1);
    expect(err[0]?.tool_name).toBe("bash");

    search.close();
  });

  it("is idempotent across runs", () => {
    const dbPath = writeOpencodeDb(tmpDir());
    const search = tmpSearch();
    importOpencode(search, new Set(), { dbPath });
    const before = search.status().chunks;
    const again = importOpencode(search, search.indexedRequestIds(), {
      dbPath,
    });
    expect(again.messages).toBe(0);
    expect(search.status().chunks).toBe(before);
    search.close();
  });

  it("skips sessions that overlap a proxied session unless forced", () => {
    const dbPath = writeOpencodeDb(tmpDir());
    const proxied = [
      {
        cwd: "/home/dev/jobs",
        startedAt: "2026-07-10T07:00:00.000Z",
        lastSeenAt: "2026-07-10T09:00:00.000Z",
      },
    ];
    const search = tmpSearch();
    const skipped = importOpencode(search, new Set(), {
      dbPath,
      proxiedSessions: proxied,
    });
    expect(skipped.sessions).toBe(0);
    expect(skipped.skippedProxied).toBe(1);

    const forced = importOpencode(search, new Set(), {
      dbPath,
      proxiedSessions: proxied,
      includeProxied: true,
    });
    expect(forced.sessions).toBe(1);
    search.close();
  });

  it("returns zeros when the opencode DB does not exist", () => {
    const search = tmpSearch();
    const summary = importOpencode(search, new Set(), {
      dbPath: join(tmpDir(), "missing.db"),
    });
    expect(summary).toEqual({
      sessions: 0,
      skippedProxied: 0,
      messages: 0,
      chunks: 0,
    });
    search.close();
  });
});

describe("overlapsProxiedSession", () => {
  const proxied = [
    {
      cwd: "/home/dev/jobs",
      startedAt: "2026-07-10T10:00:00.000Z",
      lastSeenAt: "2026-07-10T11:00:00.000Z",
    },
  ];

  it("matches same directory with intersecting windows", () => {
    expect(
      overlapsProxiedSession(
        {
          directory: "/home/dev/jobs",
          start: "2026-07-10T10:30:00.000Z",
          end: "2026-07-10T12:00:00.000Z",
        },
        proxied,
      ),
    ).toBe(true);
  });

  it("rejects different directories or disjoint windows", () => {
    expect(
      overlapsProxiedSession(
        {
          directory: "/home/dev/other",
          start: "2026-07-10T10:30:00.000Z",
          end: "2026-07-10T12:00:00.000Z",
        },
        proxied,
      ),
    ).toBe(false);
    expect(
      overlapsProxiedSession(
        {
          directory: "/home/dev/jobs",
          start: "2026-07-10T12:00:00.000Z",
          end: "2026-07-10T13:00:00.000Z",
        },
        proxied,
      ),
    ).toBe(false);
  });
});
