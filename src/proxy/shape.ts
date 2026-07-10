// OpenAI-format providers stream Server-Sent Events that omit the `usage`
// block unless the request opts in via `stream_options.include_usage`. Without
// it, token counts (and therefore cost) are unrecoverable. This shaper injects
// the flag on every applicable request, independent of the optimize layer.
const OPENAI_FORMAT_PROVIDERS: ReadonlySet<string> = new Set([
  "openai",
  "deepseek",
]);

function isChatCompletionsPath(path: string): boolean {
  const query = path.indexOf("?");
  const bare = query === -1 ? path : path.slice(0, query);
  return bare.endsWith("/chat/completions");
}

export function needsShaping(
  provider: string,
  method: string,
  path: string,
): boolean {
  return (
    method.toUpperCase() === "POST" &&
    OPENAI_FORMAT_PROVIDERS.has(provider) &&
    isChatCompletionsPath(path)
  );
}

export function shapeRequestBody(
  body: Buffer,
  provider: string,
  method: string,
  path: string,
): Buffer {
  if (!needsShaping(provider, method, path)) return body;
  if (body.length === 0) return body;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return body;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return body;
  }

  const record = parsed as Record<string, unknown>;
  if (record.stream !== true) return body;

  const existing =
    record.stream_options &&
    typeof record.stream_options === "object" &&
    !Array.isArray(record.stream_options)
      ? (record.stream_options as Record<string, unknown>)
      : {};
  if (existing.include_usage === true) return body;

  record.stream_options = { ...existing, include_usage: true };
  return Buffer.from(JSON.stringify(record), "utf8");
}
