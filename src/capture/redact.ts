import type { IncomingHttpHeaders } from "node:http";

export const REDACTED = "[REDACTED]";

const SENSITIVE_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "x-api-key",
  "api-key",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-amz-security-token",
  "x-goog-api-key",
]);

const SENSITIVE_QUERY_PARAMS: ReadonlySet<string> = new Set([
  "api_key",
  "key",
  "token",
  "access_token",
]);

export function redactHeaders(
  headers: IncomingHttpHeaders,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[key] = SENSITIVE_HEADERS.has(key.toLowerCase()) ? REDACTED : value;
  }
  return out;
}

export function redactUrl(url: string): string {
  const qIndex = url.indexOf("?");
  if (qIndex === -1) return url;
  const path = url.slice(0, qIndex);
  const params = new URLSearchParams(url.slice(qIndex + 1));
  let redacted = false;
  for (const key of params.keys()) {
    if (SENSITIVE_QUERY_PARAMS.has(key.toLowerCase())) {
      params.set(key, REDACTED);
      redacted = true;
    }
  }
  return redacted ? `${path}?${params.toString()}` : url;
}
