export interface RequestLogEntry {
  sessionId: string | null;
  provider: string;
  method: string;
  path: string;
  status: number | null;
  latencyMs: number;
  responseBytes: number;
  error?: string;
}

export type RequestLogger = (entry: RequestLogEntry) => void;

export function consoleRequestLogger(
  write: (line: string) => void = console.log,
): RequestLogger {
  return (e) => {
    const time = new Date().toISOString().slice(11, 23);
    const session = e.sessionId ? e.sessionId.slice(0, 8) : "unattr";
    const status = e.status ?? "ERR";
    const suffix = e.error ? `  (${e.error})` : "";
    write(
      `${time}  ${session}  ${e.provider}  ${e.method} ${e.path} -> ${status}  ${e.latencyMs}ms  ${formatBytes(e.responseBytes)}${suffix}`,
    );
  };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}
