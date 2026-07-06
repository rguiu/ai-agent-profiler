import https from "node:https";
import { execFileSync } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import aws4 from "aws4";

interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiresAt?: number;
}

let cached: Credentials | null = null;

function resolveCredentials(profile?: string): Credentials {
  if (cached && cached.expiresAt && Date.now() < cached.expiresAt - 60_000) {
    return cached;
  }

  const env = process.env;

  // Direct env vars take priority
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
    cached = {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      sessionToken: env.AWS_SESSION_TOKEN,
    };
    return cached;
  }

  // Fall back to aws CLI
  const args = ["configure", "export-credentials", "--format", "process"];
  if (profile) args.push("--profile", profile);
  const out = execFileSync("aws", args, { stdio: ["ignore", "pipe", "ignore"] });
  const parsed = JSON.parse(out.toString()) as {
    AccessKeyId: string;
    SecretAccessKey: string;
    SessionToken?: string;
    Expiration?: string;
  };
  cached = {
    accessKeyId: parsed.AccessKeyId,
    secretAccessKey: parsed.SecretAccessKey,
    sessionToken: parsed.SessionToken,
    expiresAt: parsed.Expiration ? new Date(parsed.Expiration).getTime() : undefined,
  };
  return cached;
}

export interface BedrockForwardOpts {
  upstreamHost: string;
  path: string;
  region: string;
  extraHeaders?: Record<string, string>;
  onRequestChunk?: (chunk: Buffer) => void;
  onResponse?: (status: number, headers: Record<string, string | string[]>) => void;
  onResponseChunk?: (chunk: Buffer) => void;
  onFinish?: () => void;
}

export function forwardBedrock(
  req: IncomingMessage,
  res: ServerResponse,
  opts: BedrockForwardOpts,
): void {
  const { upstreamHost, path, region, extraHeaders, onRequestChunk, onResponse, onResponseChunk, onFinish } = opts;
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
    onRequestChunk?.(chunk);
  });
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const profile = process.env.AWS_PROFILE;
    let creds: Credentials;
    try {
      creds = resolveCredentials(profile);
    } catch (err) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `Failed to resolve AWS credentials: ${(err as Error).message}` }));
      onFinish?.();
      return;
    }

    const contentType = req.headers["content-type"] ?? "application/json";
    const headers: Record<string, string> = {
      "content-type": contentType,
      host: upstreamHost,
      ...extraHeaders,
    };
    const signed = aws4.sign(
      {
        service: "bedrock",
        region,
        host: upstreamHost,
        method: req.method ?? "POST",
        path,
        headers,
        body,
      },
      {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        sessionToken: creds.sessionToken,
      },
    );

    const upstreamReq = https.request(
      {
        hostname: upstreamHost,
        port: 443,
        method: req.method,
        path,
        headers: signed.headers,
      },
      (upstreamRes) => {
        const status = upstreamRes.statusCode ?? 502;
        const headers = upstreamRes.headers as Record<string, string | string[]>;
        onResponse?.(status, headers);
        res.writeHead(status, upstreamRes.headers);
        upstreamRes.on("data", (chunk: Buffer) => {
          onResponseChunk?.(chunk);
        });
        upstreamRes.pipe(res);
      },
    );

    upstreamReq.on("error", (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `Bedrock upstream error: ${err.message}` }));
      } else {
        res.destroy();
      }
      onFinish?.();
    });

    res.on("finish", () => onFinish?.());
    res.on("close", () => {
      if (!res.writableFinished) upstreamReq.destroy();
      onFinish?.();
    });

    upstreamReq.end(body);
  });
}
