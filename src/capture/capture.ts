import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { SessionInfo } from "../session/index.js";
import type { Store } from "../store/index.js";
import { redactHeaders, redactUrl } from "./redact.js";

export interface RequestContext {
  sessionId: string;
  requestId: string;
  provider: string;
  /** Agent inferred from the request (UA / x-aap-client), when known. */
  client?: string | null;
  method: string;
  path: string;
  httpVersion: string;
  headers: IncomingHttpHeaders;
  startedAt: number;
  keepAlive?: boolean;
}

export interface RequestTrace {
  requestChunk(chunk: Buffer): void;
  response(
    status: number,
    statusMessage: string | undefined,
    headers: IncomingHttpHeaders,
  ): void;
  responseChunk(chunk: Buffer): void;
  error(phase: string, message: string): void;
  finish(): void;
}

export interface Capture {
  upsertSession(info: SessionInfo): void;
  nextUnattributedSession(now?: number, client?: string | null): string;
  begin(ctx: RequestContext): RequestTrace;
}

// A failed trace write (removed or unwritable trace dir, disk full…) makes the
// trace unusable. Surface it on the request so it stops looking like a
// successful request that simply never got parsed.
export function captureError(
  writeError: Error | null,
  requestError: string | null,
): string | null {
  if (!writeError) return requestError;
  const message = `capture: ${writeError.message}`;
  return requestError ? `${message}; ${requestError}` : message;
}

class FileRequestTrace implements RequestTrace {
  private requestBytes = 0;
  private responseBytes = 0;
  private status: number | null = null;
  private errorMessage: string | null = null;
  private finished = false;
  private writeError: Error | null = null;

  constructor(
    private readonly store: Store,
    private readonly stream: WriteStream,
    private readonly ctx: RequestContext,
  ) {
    this.stream.on("error", (err: Error) => {
      this.writeError = err;
      process.stderr.write(
        `[capture] write error for ${ctx.requestId}: ${err.message}\n`,
      );
    });
    this.writeEvent({
      type: "request",
      ts: ctx.startedAt,
      sessionId: ctx.sessionId,
      requestId: ctx.requestId,
      provider: ctx.provider,
      method: ctx.method,
      path: redactUrl(ctx.path),
      httpVersion: ctx.httpVersion,
      headers: redactHeaders(ctx.headers),
    });
  }

  private writeEvent(event: Record<string, unknown>): void {
    if (this.stream.destroyed || this.stream.writableEnded) return;
    this.stream.write(`${JSON.stringify(event)}\n`);
  }

  requestChunk(chunk: Buffer): void {
    this.requestBytes += chunk.length;
    this.writeEvent({
      type: "request_body",
      ts: Date.now(),
      data: chunk.toString("base64"),
    });
  }

  response(
    status: number,
    statusMessage: string | undefined,
    headers: IncomingHttpHeaders,
  ): void {
    this.status = status;
    this.writeEvent({
      type: "response",
      ts: Date.now(),
      status,
      statusMessage,
      headers: redactHeaders(headers),
    });
  }

  responseChunk(chunk: Buffer): void {
    this.responseBytes += chunk.length;
    this.writeEvent({
      type: "response_body",
      ts: Date.now(),
      data: chunk.toString("base64"),
    });
  }

  error(phase: string, message: string): void {
    this.errorMessage = message;
    this.writeEvent({ type: "error", ts: Date.now(), phase, message });
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    const endedAt = Date.now();
    const latencyMs = endedAt - this.ctx.startedAt;
    this.writeEvent({
      type: "end",
      ts: endedAt,
      status: this.status,
      latencyMs,
      requestBytes: this.requestBytes,
      responseBytes: this.responseBytes,
      error: this.errorMessage,
    });
    if (!this.stream.destroyed) this.stream.end();
    this.store.finishRequest(this.ctx.requestId, {
      status: this.status,
      latencyMs,
      requestBytes: this.requestBytes,
      responseBytes: this.responseBytes,
      endedAt: new Date(endedAt).toISOString(),
      error: captureError(this.writeError, this.errorMessage),
    });
  }
}

export class FileCapture implements Capture {
  private readonly tracesDir: string;
  /** One unattributed bucket per client, so concurrent agents (pi + opencode)
   * don't collapse into a single session just because neither sends a session
   * id. Keyed by client; "" holds traffic with no identifiable client. */
  private readonly unattributed = new Map<
    string,
    { id: string; lastSeen: number }
  >();

  constructor(
    private readonly store: Store,
    dir: string,
    private readonly idleTimeoutMs: number,
  ) {
    this.tracesDir = join(dir, "traces");
  }

  upsertSession(info: SessionInfo): void {
    this.store.upsertSession(info);
  }

  nextUnattributedSession(now = Date.now(), client?: string | null): string {
    const key = client ?? "";
    const current = this.unattributed.get(key);
    if (current && now - current.lastSeen <= this.idleTimeoutMs) {
      current.lastSeen = now;
      return current.id;
    }
    const id = key
      ? `unattributed-${key}-${randomUUID()}`
      : `unattributed-${randomUUID()}`;
    this.unattributed.set(key, { id, lastSeen: now });
    return id;
  }

  begin(ctx: RequestContext): RequestTrace {
    // COALESCE on conflict: a launcher-registered session keeps its cwd/repo
    // (and `aap run` keeps winning over an inferred client).
    this.store.upsertSession({
      id: ctx.sessionId,
      client: ctx.client ?? undefined,
      startedAt: new Date(ctx.startedAt).toISOString(),
    });

    const sessionDir = join(this.tracesDir, ctx.sessionId);
    // Idempotent and cheap, so it runs on every request: a session (or its
    // trace dir) can be deleted while the proxy is still serving it, and a
    // cached "already created" flag made every later request traceless.
    mkdirSync(sessionDir, { recursive: true });
    const traceFile = join(sessionDir, `${ctx.requestId}.ndjson`);
    const stream = createWriteStream(traceFile, { flags: "a" });

    this.store.insertRequest({
      id: ctx.requestId,
      sessionId: ctx.sessionId,
      provider: ctx.provider,
      method: ctx.method,
      path: ctx.path,
      traceFile,
      startedAt: new Date(ctx.startedAt).toISOString(),
      keepAlive: ctx.keepAlive ? 1 : 0,
    });

    return new FileRequestTrace(this.store, stream, ctx);
  }
}
