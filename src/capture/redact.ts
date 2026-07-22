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

const SECRET_VALUE_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/Bearer\s+[\w\-._~+/]+=*/gi, "Bearer [REDACTED]"],
  [/\bsk-[A-Za-z0-9_-]{10,}\b/g, "[REDACTED]"],
  [/\bsk-ant-[A-Za-z0-9_-]{10,}\b/g, "[REDACTED]"],
  [/\bhf_[A-Za-z0-9]{20,}\b/g, "[REDACTED]"],
  [/\bxai-[A-Za-z0-9]{10,}\b/g, "[REDACTED]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]"],
  [
    /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g,
    "[REDACTED]",
  ],
  [/\bghp_[A-Za-z0-9]{36}\b/g, "[REDACTED]"],
  [/\bgho_[A-Za-z0-9]{36}\b/g, "[REDACTED]"],
  [/\bghu_[A-Za-z0-9]{36}\b/g, "[REDACTED]"],
  [/\bghs_[A-Za-z0-9]{36}\b/g, "[REDACTED]"],
  [/\bgithub_pat_[A-Za-z0-9_]{10,}\b/g, "[REDACTED]"],
  [/\br8_[A-Za-z0-9]{14,}\b/g, "[REDACTED]"],
];

const SECRET_KEY_ASSIGNMENT_RE =
  /(?:export\s+)?(?:[A-Za-z_]\w*)\s*=\s*(?:"[^"]{8,}"|'[^']{8,}'|[^\s"']{8,})(?=\s|$|;)/g;

const SECRET_KEY_NAMES: ReadonlySet<string> = new Set([
  "token",
  "api_key",
  "apikey",
  "api_token",
  "apitoken",
  "api_secret",
  "apisecret",
  "secret",
  "secret_key",
  "secretkey",
  "password",
  "passwd",
  "access_token",
  "accesstoken",
  "refresh_token",
  "refreshtoken",
  "auth_token",
  "authtoken",
  "authorization",
  "aws_access_key_id",
  "aws_secret_access_key",
  "aws_session_token",
  "private_key",
  "privatekey",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "DEEPSEEK_API_KEY",
  "GITHUB_TOKEN",
  "OPENROUTER_API_KEY",
  "GOOGLE_API_KEY",
  "COHERE_API_KEY",
  "MISTRAL_API_KEY",
  "GROQ_API_KEY",
  "TOGETHER_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "REPLICATE_API_TOKEN",
  "HUGGINGFACE_TOKEN",
  "HUGGING_FACE_HUB_TOKEN",
  "NODE_AUTH_TOKEN",
  "NPM_TOKEN",
]);

export function redactSecrets(text: string): string {
  if (!text || text.length === 0) return text;

  let result = text;
  for (const [regex, replacement] of SECRET_VALUE_PATTERNS) {
    result = result.replace(regex, replacement);
  }

  result = result.replace(SECRET_KEY_ASSIGNMENT_RE, (match) => {
    const eqIdx = match.indexOf("=");
    const keyPart = match
      .slice(0, eqIdx)
      .replace(/^export\s+/, "")
      .trim();
    const normalized = keyPart.toLowerCase().replace(/[_-]/g, "");
    if (SECRET_KEY_NAMES.has(keyPart) || SECRET_KEY_NAMES.has(normalized)) {
      return `${match.slice(0, eqIdx + 1)}${REDACTED}`;
    }
    return match;
  });

  return result;
}
