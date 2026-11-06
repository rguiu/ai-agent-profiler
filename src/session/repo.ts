import { execFileSync } from "node:child_process";

/**
 * Best-effort repo identity for a working directory: the git remote when there
 * is one, else the worktree root. Used by `aap run` at launch and by the
 * parser when it backfills a launcher-less session's cwd.
 */
export function detectRepo(cwd: string): string | null {
  return (
    tryGit(["config", "--get", "remote.origin.url"], cwd) ??
    tryGit(["rev-parse", "--show-toplevel"], cwd)
  );
}

function tryGit(args: string[], cwd: string): string | null {
  try {
    const out = execFileSync("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const value = out.toString().trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}
