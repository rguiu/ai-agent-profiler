import { basename } from "node:path";

/**
 * `ollama launch <agent>` does not read the provider entries `aap route` writes
 * into opencode's or pi's config: at launch time it hands the agent an inline
 * config whose base URL is `OLLAMA_HOST + "/v1"` (see ollama's
 * `cmd/launch/opencode.go`, `buildInlineConfig`). The inline config wins over
 * the user-level file, so routing those launches means setting `OLLAMA_HOST`
 * for the `ollama` process itself.
 *
 * `aap route` therefore owns a marked block in the user's login profile. It
 * defines a function rather than a bare `export` on purpose: `ollama serve`
 * reads `OLLAMA_HOST` to choose its bind address, so a global export would make
 * the daemon fight the proxy for the same port. Only `launch` is redirected.
 */

export const OLLAMA_BLOCK_BEGIN = "# >>> aap route: ollama >>>";
export const OLLAMA_BLOCK_END = "# <<< aap route: ollama <<<";

/** `export OLLAMA_HOST=http://…` in the user's own part of the profile. */
const EXPORTED_OLLAMA_HOST_RE =
  /^\s*export\s+OLLAMA_HOST=(?:"([^"]+)"|'([^']+)'|([^\s#]+))/;

/** Origin the managed block assigns, when there is one. */
const MANAGED_ORIGIN_RE = /OLLAMA_HOST=(?:"([^"]+)"|'([^']+)')/;

/** Login profile for `$SHELL`, or null for a shell we can't edit safely. */
export function shellProfilePath(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  switch (basename(env.SHELL ?? "")) {
    case "zsh":
      return `${home}/.zshrc`;
    case "bash":
      return `${home}/.bashrc`;
    default:
      return null;
  }
}

/** The block `aap route` writes: route `ollama launch`, nothing else. */
export function ollamaShellBlock(origin: string): string {
  return [
    OLLAMA_BLOCK_BEGIN,
    "# `ollama launch <agent>` builds the agent's base URL from OLLAMA_HOST when",
    "# it starts, so the provider entries `aap route` writes for opencode and pi",
    "# never apply. Scoped to `launch`: `ollama serve` reads OLLAMA_HOST for its",
    "# bind address and has to keep its own.",
    "ollama() {",
    '  if [ "$1" = "launch" ]; then',
    `    OLLAMA_HOST='${origin}' command ollama "$@"`,
    "  else",
    '    command ollama "$@"',
    "  fi",
    "}",
    OLLAMA_BLOCK_END,
  ].join("\n");
}

export interface OllamaShellState {
  /** The managed block is present. */
  managed: boolean;
  /** Origin the managed block assigns (null when absent or unparseable). */
  managedOrigin: string | null;
  /** Origin of the user's own `export OLLAMA_HOST=…`, if the profile has one. */
  exportedOrigin: string | null;
}

/** What a profile currently says about `OLLAMA_HOST`. */
export function ollamaShellState(text: string): OllamaShellState {
  const managed = managedRange(text);
  const outsideManaged =
    managed === null
      ? text
      : text.slice(0, managed.start) + text.slice(managed.end);

  let exportedOrigin: string | null = null;
  for (const line of outsideManaged.split("\n")) {
    const match = EXPORTED_OLLAMA_HOST_RE.exec(line);
    if (match) exportedOrigin = match[1] ?? match[2] ?? match[3] ?? null;
  }

  return {
    managed: managed !== null,
    managedOrigin: managed === null ? null : managedOriginIn(managed.body),
    exportedOrigin,
  };
}

/** Add the managed block, or update an existing one to `origin`. */
export function upsertOllamaBlock(text: string, origin: string): string {
  const block = ollamaShellBlock(origin);
  const managed = managedRange(text);
  if (managed !== null) {
    return text.slice(0, managed.start) + block + text.slice(managed.end);
  }
  // Keep the user's last line intact whether or not the file ended with a
  // newline, and leave one blank line before our block.
  const base = text.length === 0 || text.endsWith("\n") ? text : `${text}\n`;
  return `${base}${base.length > 0 ? "\n" : ""}${block}\n`;
}

/** Remove the managed block, leaving the user's own lines untouched. */
export function removeOllamaBlock(text: string): string {
  const managed = managedRange(text);
  if (managed === null) return text;

  const before = text.slice(0, managed.start);
  const after = text.slice(managed.end);
  // `upsertOllamaBlock` separated the block from the user's content with one
  // blank line and terminated the block with a newline; drop both again so an
  // undo is byte-identical apart from the block itself.
  return `${before.replace(/\n\n$/, "\n")}${after.replace(/^\n/, "")}`;
}

interface ManagedRange {
  start: number;
  end: number;
  body: string;
}

function managedRange(text: string): ManagedRange | null {
  const lines = text.split("\n");
  const beginLine = lines.findIndex(
    (line) => line.trim() === OLLAMA_BLOCK_BEGIN,
  );
  if (beginLine === -1) return null;
  const endLine = lines.findIndex(
    (line, index) => index > beginLine && line.trim() === OLLAMA_BLOCK_END,
  );
  if (endLine === -1) return null;

  // Character offsets, so callers can splice the block without splitting the
  // file again and losing the user's line endings.
  const lineStart = (line: number): number => {
    let offset = 0;
    for (let index = 0; index < line; index += 1) {
      offset += (lines[index]?.length ?? 0) + 1;
    }
    return offset;
  };
  const start = lineStart(beginLine);
  const end = lineStart(endLine) + (lines[endLine]?.length ?? 0);
  return { start, end, body: text.slice(start, end) };
}

function managedOriginIn(body: string): string | null {
  const match = MANAGED_ORIGIN_RE.exec(body);
  return match?.[1] ?? match?.[2] ?? null;
}
