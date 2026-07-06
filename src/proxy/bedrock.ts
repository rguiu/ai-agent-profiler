import https from "node:https";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { IncomingMessage, ServerResponse } from "node:http";
import aws4 from "aws4";

const execFileAsync = promisify(execFile);

const UPSTREAM_TIMEOUT_MS = 30_000;

interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiresAt?: number;
}

let cached: Credentials | null = null;
let cachedProfile: string | undefined;

async function resolveCredentials(profile?: string): Promise<Credentials> {
  if (
    cached &&
    cachedProfile === profile &&
    cached.expiresAt &&
    Date.now() < cached.expiresAt - 60_000
  ) {
    return cached;
  }

  const env = process.env;

  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
    cached = {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      sessionToken: env.AWS_SESSION_TOKEN,
    };
    cachedProfile = profile;
    return cached;
  }

  const args = ["configure", "export-credentials", "--format", "process"];
  if (profile) args.push("--profile", profile);
  const { stdout } = await execFileAsync("aws", args);
  const parsed = JSON.parse(stdout) as {
    AccessKeyId: string;
    SecretAccessKey: string;
    SessionToken?: string;
    Expiration?: string;
  };
  cached = {
    accessKeyId: parsed.AccessKeyId,
    secretAccessKey: parsed.SecretAccessKey,
    sessionToken: parsed.SessionToken,
    expiresAt: parsed.Expiration
      ? new Date(parsed.Expiration).getTime()
      : undefined,
  };
  cachedProfile = profile;
  return cached;
}

export interface BedrockForwardOpts {
  upstreamHost: string;
  path: string;
  region: string;
  extraHeaders?: Record<string, string>;
  rewriteBody?: (body: Buffer) => Buffer;
  onRequestChunk?: (chunk: Buffer) => void;
  onResponse?: (
    status: number,
    headers: Record<string, string | string[]>,
  ) => void;
  onResponseChunk?: (chunk: Buffer) => void;
  onFinish?: () => void;
}

export function forwardBedrock(
  req: IncomingMessage,
  res: ServerResponse,
  opts: BedrockForwardOpts,
): void {
  const {
    upstreamHost,
    path,
    region,
    extraHeaders,
    rewriteBody,
    onRequestChunk,
    onResponse,
    onResponseChunk,
    onFinish,
  } = opts;

  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    onFinish?.();
  };

  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
    onRequestChunk?.(chunk);
  });
  req.on("end", () => {
    let body: Buffer = Buffer.concat(chunks) as Buffer;
    if (rewriteBody) body = rewriteBody(body);
    const profile = process.env.AWS_PROFILE;

    resolveCredentials(profile)
      .then((creds) => {
        const contentType = req.headers["content-type"] ?? "application/json";
        const hdrs: Record<string, string> = {
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
            headers: hdrs,
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
            timeout: UPSTREAM_TIMEOUT_MS,
          },
          (upstreamRes) => {
            const status = upstreamRes.statusCode ?? 502;
            const respHeaders = upstreamRes.headers as Record<
              string,
              string | string[]
            >;
            onResponse?.(status, respHeaders);
            res.writeHead(status, upstreamRes.headers);
            upstreamRes.on("data", (chunk: Buffer) => {
              onResponseChunk?.(chunk);
            });
            upstreamRes.pipe(res);
          },
        );

        upstreamReq.on("timeout", () => upstreamReq.destroy());
        upstreamReq.on("error", (err) => {
          if (!res.headersSent) {
            res.writeHead(502, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                error: `Bedrock upstream error: ${err.message}`,
              }),
            );
          } else {
            res.destroy();
          }
          finish();
        });

        res.on("finish", finish);
        res.on("close", () => {
          if (!res.writableFinished) upstreamReq.destroy();
          finish();
        });

        upstreamReq.end(body);
      })
      .catch((err: Error) => {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: `Failed to resolve AWS credentials: ${err.message}`,
          }),
        );
        finish();
      });
  });
}
