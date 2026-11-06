import { describe, expect, it } from "vitest";
import {
  OLLAMA_BLOCK_BEGIN,
  OLLAMA_BLOCK_END,
  ollamaShellBlock,
  ollamaShellState,
  removeOllamaBlock,
  shellProfilePath,
  upsertOllamaBlock,
} from "./shell-profile.js";

const ORIGIN = "http://127.0.0.1:8080";
const OTHER = "http://127.0.0.1:9090";

describe("shellProfilePath", () => {
  it("picks the login profile of the user's shell", () => {
    expect(shellProfilePath("/h", { SHELL: "/bin/zsh" })).toBe("/h/.zshrc");
    expect(shellProfilePath("/h", { SHELL: "/usr/local/bin/bash" })).toBe(
      "/h/.bashrc",
    );
  });

  it("refuses a shell whose syntax it doesn't write", () => {
    expect(shellProfilePath("/h", { SHELL: "/usr/bin/fish" })).toBeNull();
    expect(shellProfilePath("/h", {})).toBeNull();
  });
});

describe("ollamaShellBlock", () => {
  it("routes only `launch`, so `ollama serve` keeps its bind address", () => {
    const block = ollamaShellBlock(ORIGIN);
    expect(block).toContain(`OLLAMA_HOST='${ORIGIN}' command ollama "$@"`);
    expect(block).toContain('if [ "$1" = "launch" ]');
    expect(block).toContain('command ollama "$@"');
    expect(block).not.toMatch(/^\s*export\s+OLLAMA_HOST=/m);
    expect(block.startsWith(OLLAMA_BLOCK_BEGIN)).toBe(true);
    expect(block.endsWith(OLLAMA_BLOCK_END)).toBe(true);
  });
});

describe("upsertOllamaBlock", () => {
  it("appends the block and leaves the user's profile intact", () => {
    const original = 'export EDITOR=vim\n\nalias gs="git status"\n';
    const next = upsertOllamaBlock(original, ORIGIN);

    expect(next.startsWith(original)).toBe(true);
    expect(next.match(new RegExp(OLLAMA_BLOCK_BEGIN, "g"))).toHaveLength(1);
  });

  it("is idempotent", () => {
    const once = upsertOllamaBlock("export EDITOR=vim\n", ORIGIN);
    expect(upsertOllamaBlock(once, ORIGIN)).toBe(once);
  });

  it("updates an existing block instead of adding a second one", () => {
    const once = upsertOllamaBlock("export EDITOR=vim\n", ORIGIN);
    const moved = upsertOllamaBlock(once, OTHER);

    expect(moved).toContain(OTHER);
    expect(moved).not.toContain(`OLLAMA_HOST='${ORIGIN}'`);
    expect(moved.match(new RegExp(OLLAMA_BLOCK_BEGIN, "g"))).toHaveLength(1);
  });

  it("handles a profile without a trailing newline", () => {
    expect(upsertOllamaBlock("export EDITOR=vim", ORIGIN)).toContain(
      `export EDITOR=vim\n\n${OLLAMA_BLOCK_BEGIN}`,
    );
  });
});

describe("removeOllamaBlock", () => {
  it("round-trips the profile without the block", () => {
    const original = 'export EDITOR=vim\n\nalias gs="git status"\n';
    expect(removeOllamaBlock(upsertOllamaBlock(original, ORIGIN))).toBe(
      original,
    );
  });

  it("removes only the block, keeping edits made after the write", () => {
    const routed = upsertOllamaBlock("export EDITOR=vim\n", ORIGIN);
    const edited = `${routed}\nexport LATER=1\n`;
    const undone = removeOllamaBlock(edited);

    expect(undone).toContain("export EDITOR=vim");
    expect(undone).toContain("export LATER=1");
    expect(undone).not.toContain(OLLAMA_BLOCK_BEGIN);
  });

  it("leaves a profile without a block untouched", () => {
    expect(removeOllamaBlock("export EDITOR=vim\n")).toBe(
      "export EDITOR=vim\n",
    );
  });
});

describe("ollamaShellState", () => {
  it("reports the origin in the managed block", () => {
    const text = upsertOllamaBlock("export EDITOR=vim\n", ORIGIN);
    expect(ollamaShellState(text)).toEqual({
      managed: true,
      managedOrigin: ORIGIN,
      exportedOrigin: null,
    });
  });

  it("spots a user's own export outside the block", () => {
    const text = `export OLLAMA_HOST=${OTHER}\n`;
    expect(ollamaShellState(text)).toEqual({
      managed: false,
      managedOrigin: null,
      exportedOrigin: OTHER,
    });
  });

  it("does not treat the block's inline assignment as an export", () => {
    const text = upsertOllamaBlock("", OTHER);
    expect(ollamaShellState(text).exportedOrigin).toBeNull();
  });
});
