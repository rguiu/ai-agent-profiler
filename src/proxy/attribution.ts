import type { IncomingHttpHeaders } from "node:http";

/**
 * Attribution without a launcher: the client tells us who it is on the wire.
 *
 * `aap run` puts the session id in the base URL (`/<session>/<provider>`), which
 * is why it has to intercept every launch. Clients that already send a session
 * id of their own don't need that: the base URL stays constant, so it can live
 * in a config file (`aap route`), and the traffic is still attributed per
 * session. Claude Code sends `x-claude-code-session-id` on every request.
 *
 * Precedence is explicit > header > unattributed: a session id in the path
 * (benchmark pinning) or the active Bedrock/Ollama pin always wins, so `aap run`
 * keeps working unchanged.
 */
export const SESSION_HEADERS = [
  "x-aap-session",
  "x-claude-code-session-id",
] as const;

/** Same shape route.ts accepts for path session ids — it becomes a directory. */
const SAFE_SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;
const MAX_SESSION_ID_LEN = 128;
const MAX_CLIENT_LEN = 40;
const SAFE_CLIENT_RE = /^[A-Za-z0-9._-]+$/;

function headerValue(
  headers: IncomingHttpHeaders,
  name: string,
): string | null {
  const raw = headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Session id advertised by the client, or null when it doesn't send one. */
export function sessionIdFromHeaders(
  headers: IncomingHttpHeaders,
): string | null {
  for (const name of SESSION_HEADERS) {
    const value = headerValue(headers, name);
    if (
      value &&
      value.length <= MAX_SESSION_ID_LEN &&
      SAFE_SESSION_ID_RE.test(value)
    ) {
      return value;
    }
  }
  return null;
}

// Ordered: the first match wins, so more specific products come first.
const USER_AGENT_CLIENTS: ReadonlyArray<[RegExp, string]> = [
  [/^claude-(cli|code)/i, "claude"],
  [/^opencode\//i, "opencode"],
  [/^pi(-coding-agent)?\//i, "pi"],
  [/^ollama\//i, "ollama-cli"],
  [/^aws-sdk-/i, "aws-sdk"],
];

function clientFromUserAgent(userAgent: string | null): string | null {
  if (!userAgent) return null;
  for (const [pattern, client] of USER_AGENT_CLIENTS) {
    if (pattern.test(userAgent)) return client;
  }
  // Claude Code's UA is stable (`claude-cli/2.x.y (external, cli)`), but a
  // gateway may rewrite it — fall back to a substring check on the products we
  // can recognise unambiguously.
  const lowered = userAgent.toLowerCase();
  if (lowered.includes("claude-code") || lowered.includes("claude-cli")) {
    return "claude";
  }
  if (lowered.includes("opencode")) return "opencode";
  if (lowered.includes("pi-coding-agent")) return "pi";
  return null;
}

/** Which agent is talking: `x-aap-client` when set, else derived from the UA. */
export function clientFromHeaders(headers: IncomingHttpHeaders): string | null {
  const explicit = headerValue(headers, "x-aap-client");
  if (
    explicit &&
    explicit.length <= MAX_CLIENT_LEN &&
    SAFE_CLIENT_RE.test(explicit)
  ) {
    return explicit;
  }
  return clientFromUserAgent(headerValue(headers, "user-agent"));
}
