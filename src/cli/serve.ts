import { FileCapture } from "../capture/index.js";
import { loadConfig } from "../config/index.js";
import { runParse } from "../parse/index.js";
import { consoleRequestLogger, createProxyServer } from "../proxy/index.js";
import {
  openSearchStore,
  runIndex,
  type SearchStore,
} from "../search/index.js";
import { SessionRegistry } from "../session/index.js";
import { openStore } from "../store/index.js";

const PARSE_INTERVAL_MS = 3000;
const SHUTDOWN_TIMEOUT_MS = 5000;

export function serve(args?: string[]): void {
  const portIdx = args?.indexOf("--port") ?? -1;
  const portArg = portIdx >= 0 ? args?.[portIdx + 1] : undefined;
  const cliPort = portArg ? parseInt(portArg, 10) : undefined;
  const config = loadConfig();
  const registry = new SessionRegistry();
  const store = openStore(config.storage.dir);
  const searchStore: SearchStore | null = config.search.enabled
    ? openSearchStore(config.storage.dir)
    : null;

  // Hydrate in-memory registry from persisted sessions so that metadata
  // (e.g. armada_node) survives a proxy restart mid-session.
  const rows = store.recentSessions();
  registry.hydrate(
    rows.map((r) => ({
      id: r.id,
      client: r.client ?? undefined,
      cwd: r.cwd ?? undefined,
      repo: r.repo,
      startedAt: r.started_at ?? new Date().toISOString(),
      meta: r.meta ? (JSON.parse(r.meta) as Record<string, string>) : null,
    })),
  );

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
    searchStore,
  );

  const port = cliPort ?? config.server.port;
  server.listen(port, config.server.host, () => {
    console.log(`aap proxy listening on http://${config.server.host}:${port}`);
    console.log(`providers: ${Object.keys(config.providers).join(", ")}`);
    console.log(`storage: ${config.storage.dir}`);
    if (rows.length > 0) {
      console.log(`hydrated ${rows.length} session(s) from store`);
    }
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

  // Search indexing follows the same off-hot-path pattern as parsing: small
  // batches on a timer, writing to its own search.sqlite so the proxy's
  // store is never contended.
  let indexing = false;
  const indexTimer = searchStore
    ? setInterval(() => {
        if (indexing) return;
        indexing = true;
        runIndex(store, searchStore, { limit: config.search.batchSize })
          .then((summary) => {
            if (summary.indexed > 0) {
              console.log(
                `indexed ${summary.indexed} request(s) (${summary.chunks} chunks)`,
              );
            }
          })
          .catch((err: Error) => {
            console.error(`background index failed: ${err.message}`);
          })
          .finally(() => {
            indexing = false;
          });
      }, config.search.intervalMs)
    : null;
  indexTimer?.unref();

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("shutting down — draining in-flight requests...");
    clearInterval(parseTimer);
    if (indexTimer) clearInterval(indexTimer);

    // Stop accepting new connections; existing ones finish naturally.
    server.close(() => {
      store.close();
      searchStore?.close();
      process.exit(0);
    });

    // Force-close after a timeout so we don't hang indefinitely.
    const forceTimer = setTimeout(() => {
      console.error(
        `shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms — forcing exit`,
      );
      server.closeAllConnections();
      store.close();
      searchStore?.close();
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceTimer.unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
