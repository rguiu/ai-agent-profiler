export interface Route {
  sessionId: string | null;
  provider: string;
  upstreamPath: string;
}

// Bedrock SDK sends requests like /model/{id}/converse-stream — no prefix.
const BEDROCK_PATH_RE = /^\/model\//;

// `aap run` on Bedrock sets the base URL to /aap-session/{id}, so requests
// arrive as /aap-session/{id}/model/{modelId}/... — the session id is in the
// path (not a race-prone global). The proxy strips the /aap-session/{id}
// prefix before re-signing, so AWS only ever sees /model/....
const BEDROCK_SESSION_PATH_RE = /^\/aap-session\/([^/]+)(\/model\/.*)$/;

// Ollama CLI talks to its native API (/api/chat, /api/generate, /api/tags…).
// OLLAMA_HOST carries only scheme+host+port — no path — so these arrive without
// a session/provider prefix and are matched by path like Bedrock.
const OLLAMA_PATH_RE = /^\/api\//;

const SAFE_SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;

export function parseRoute(
  pathname: string,
  providers: ReadonlySet<string>,
  bedrockSessionId?: string | null,
  ollamaSessionId?: string | null,
): Route | null {
  // Session-scoped Bedrock (from `aap run`): /aap-session/{id}/model/... — take
  // the session id from the path and strip the prefix so the re-signed upstream
  // request is the plain /model/... AWS expects. Preferred over the global
  // fallback so concurrent Bedrock agents don't cross-attribute.
  if (providers.has("bedrock")) {
    const m = BEDROCK_SESSION_PATH_RE.exec(pathname);
    if (m && SAFE_SESSION_ID_RE.test(m[1] ?? "")) {
      return {
        sessionId: m[1] ?? null,
        provider: "bedrock",
        upstreamPath: m[2] ?? "/",
      };
    }
  }

  // Bedrock paths without a session prefix (transparent proxying, or a client
  // not launched via `aap run`): AWS SDK sets an absolute path
  // (/model/{modelId}/converse-stream). Fall back to the active session.
  if (providers.has("bedrock") && BEDROCK_PATH_RE.test(pathname)) {
    return {
      sessionId: bedrockSessionId ?? null,
      provider: "bedrock",
      upstreamPath: pathname,
    };
  }

  // Ollama native paths: no prefix possible via OLLAMA_HOST. Attribute to the
  // active ollama session (set by `aap run ollama`).
  if (providers.has("ollama") && OLLAMA_PATH_RE.test(pathname)) {
    return {
      sessionId: ollamaSessionId ?? null,
      provider: "ollama",
      upstreamPath: pathname,
    };
  }

  const trimmed = pathname.startsWith("/") ? pathname.slice(1) : pathname;
  if (trimmed.length === 0) return null;

  const firstSlash = trimmed.indexOf("/");
  const first = firstSlash === -1 ? trimmed : trimmed.slice(0, firstSlash);
  const afterFirst = firstSlash === -1 ? "" : trimmed.slice(firstSlash);

  if (providers.has(first)) {
    return {
      sessionId: null,
      provider: first,
      upstreamPath: afterFirst || "/",
    };
  }

  const rest = afterFirst.startsWith("/") ? afterFirst.slice(1) : afterFirst;
  if (rest.length === 0) return null;
  const secondSlash = rest.indexOf("/");
  const second = secondSlash === -1 ? rest : rest.slice(0, secondSlash);
  const afterSecond = secondSlash === -1 ? "" : rest.slice(secondSlash);
  if (!providers.has(second)) return null;
  if (!SAFE_SESSION_ID_RE.test(first)) return null;

  return {
    sessionId: first,
    provider: second,
    upstreamPath: afterSecond || "/",
  };
}
