import { FileCapture } from "../capture/index.js";
import { loadConfig } from "../config/index.js";
import { runParse } from "../parse/index.js";
import { consoleRequestLogger, createProxyServer } from "../proxy/index.js";
import { SessionRegistry } from "../session/index.js";
import { openStore } from "../store/index.js";

const PARSE_INTERVAL_MS = 3000;
const SHUTDOWN_TIMEOUT_MS = 5000;
// Sessions untouched for 2h are swept from memory; they recover if seen again.
const SESSION_IDLE_MS = 2 * 60 * 60 * 1000;
const SESSION_PRUNE_INTERVAL_MS = 10 * 60 * 1000;

export function serve(args?: string[]): void {
  const portIdx = args?.indexOf("--port") ?? -1;
  const portArg = portIdx >= 0 ? args?.[portIdx + 1] : undefined;
  const cliPort = portArg ? parseInt(portArg, 10) : undefined;
  const config = loadConfig();
  const store = openStore(config.storage.dir);

  // The in-memory registry starts empty — persisted sessions are NOT hydrated
  // on start (stale ones would otherwise sit in memory until the first prune).
  // Instead the registry recovers a session lazily from the store on lookup, so
  // its metadata (armada_node, cache_ttl, …) survives prune and restart.
  const registry = new SessionRegistry(SESSION_IDLE_MS, (id) => {
    const row = store.getSessionRow(id);
    if (!row) return undefined;
    return {
      id: row.id,
      client: row.client ?? undefined,
      cwd: row.cwd ?? undefined,
      repo: row.repo,
      startedAt: row.started_at ?? new Date().toISOString(),
      meta: row.meta,
    };
  });

  const capture = new FileCapture(
    store,
    config.storage.dir,
    config.sessions.idleTimeoutMs,
  );
  const server = createProxyServer(
    config,
    registry,
    capture,
    store,
    consoleRequestLogger(),
  );

  const port = cliPort ?? config.server.port;
  server.listen(port, config.server.host, () => {
    console.log(`aap proxy listening on http://${config.server.host}:${port}`);
    console.log(`providers: ${Object.keys(config.providers).join(", ")}`);
    console.log(`storage: ${config.storage.dir}`);
  });

  // Capture stays on the hot path; parsing runs on a background tick so that
  // finished requests turn into metrics/tool calls without a manual `aap parse`.
  let parsing = false;
  const parseTimer = setInterval(() => {
    if (parsing) return;
    parsing = true;
    runParse(store, config.pricing, { all: false })
      .then((summary) => {
        if (summary.parsed > 0) {
          console.log(`parsed ${summary.parsed} request(s)`);
        }
      })
      .catch((err: Error) => {
        console.error(`background parse failed: ${err.message}`);
      })
      .finally(() => {
        parsing = false;
      });
  }, PARSE_INTERVAL_MS);
  parseTimer.unref();

  // Sweep idle sessions out of the in-memory registry so long-running proxies
  // don't accumulate them. Persisted state is untouched — a later request
  // re-registers (recovers) the session.
  const pruneTimer = setInterval(() => {
    const removed = registry.prune();
    if (removed > 0) {
      console.log(`pruned ${removed} idle session(s) from memory`);
    }
  }, SESSION_PRUNE_INTERVAL_MS);
  pruneTimer.unref();

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("shutting down — draining in-flight requests...");
    clearInterval(parseTimer);
    clearInterval(pruneTimer);

    // Stop accepting new connections; existing ones finish naturally.
    server.close(() => {
      store.close();
      process.exit(0);
    });

    // Force-close after a timeout so we don't hang indefinitely.
    const forceTimer = setTimeout(() => {
      console.error(
        `shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms — forcing exit`,
      );
      server.closeAllConnections();
      store.close();
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceTimer.unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
