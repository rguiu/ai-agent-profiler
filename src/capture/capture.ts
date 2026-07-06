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
  method: string;
  path: string;
  httpVersion: string;
  headers: IncomingHttpHeaders;
  startedAt: number;
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
  nextUnattributedSession(now?: number): string;
  begin(ctx: RequestContext): RequestTrace;
}

class FileRequestTrace implements RequestTrace {
  private requestBytes = 0;
  private responseBytes = 0;
  private status: number | null = null;
  private errorMessage: string | null = null;
  private finished = false;

  constructor(
    private readonly store: Store,
    private readonly stream: WriteStream,
    private readonly ctx: RequestContext,
  ) {
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
      error: this.errorMessage,
    });
  }
}

export class FileCapture implements Capture {
  private readonly tracesDir: string;
  private readonly createdDirs = new Set<string>();
  private unattributedId: string | null = null;
  private unattributedLastSeen = 0;

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

  nextUnattributedSession(now = Date.now()): string {
    if (
      this.unattributedId === null ||
      now - this.unattributedLastSeen > this.idleTimeoutMs
    ) {
      this.unattributedId = `unattributed-${randomUUID()}`;
    }
    this.unattributedLastSeen = now;
    return this.unattributedId;
  }

  begin(ctx: RequestContext): RequestTrace {
    this.store.upsertSession({
      id: ctx.sessionId,
      startedAt: new Date(ctx.startedAt).toISOString(),
    });

    const sessionDir = join(this.tracesDir, ctx.sessionId);
    if (!this.createdDirs.has(sessionDir)) {
      mkdirSync(sessionDir, { recursive: true });
      this.createdDirs.add(sessionDir);
    }
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
    });

    return new FileRequestTrace(this.store, stream, ctx);
  }
}
