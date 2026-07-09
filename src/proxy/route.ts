export interface Route {
  sessionId: string | null;
  provider: string;
  upstreamPath: string;
}

// Bedrock SDK sends requests like /model/{id}/converse-stream — no prefix.
const BEDROCK_PATH_RE = /^\/model\//;

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
  // Bedrock paths: AWS SDK uses the endpoint as host-only and sets an absolute
  // path (/model/{modelId}/converse-stream). Match these before normal routing.
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
