/**
 * Working-directory recovery for launcher-less sessions.
 *
 * Agents describe their environment in the system prompt:
 *
 *   <env>
 *   Working directory: /Users/me/code/project
 *   Is directory a git repo: Yes
 *   Platform: darwin
 *   </env>
 *
 * Both Claude Code and opencode emit that block, so parsing it recovers the cwd
 * that `aap run` used to supply at launch — without touching the hot path
 * (the parser runs off the request path, and `sessions.cwd` is backfilled).
 */

const WORKING_DIR_RE =
  /(?:^|\n)[ \t]*(?:Primary working directory|Working directory)[ \t]*:[ \t]*([^\n\r<]+)/i;

const MAX_PATH_LEN = 4096;

/** Extract the working directory advertised in a system prompt, or null. */
export function extractWorkingDirectory(systemText: string): string | null {
  if (!systemText) return null;
  const match = WORKING_DIR_RE.exec(systemText);
  if (!match) return null;
  const value = (match[1] ?? "")
    .trim()
    // Agents quote the path inconsistently; strip one layer of quotes.
    .replace(/^["'`]|["'`]$/g, "")
    .trim();
  if (value.length === 0 || value.length > MAX_PATH_LEN) return null;
  // Only absolute paths: a relative one is meaningless as a session attribute
  // and would silently resolve against the proxy's own cwd.
  if (!isAbsolutePath(value)) return null;
  return value;
}

function isAbsolutePath(value: string): boolean {
  if (value.startsWith("/")) return true;
  // Windows drive paths (C:\… or C:/…)
  return /^[A-Za-z]:[\\/]/.test(value);
}
