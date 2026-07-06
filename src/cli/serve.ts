import { FileCapture } from "../capture/index.js";
import { loadConfig } from "../config/index.js";
import { runParse } from "../parse/index.js";
import { consoleRequestLogger, createProxyServer } from "../proxy/index.js";
import { SessionRegistry } from "../session/index.js";
import { openStore } from "../store/index.js";

const PARSE_INTERVAL_MS = 3000;
const SHUTDOWN_TIMEOUT_MS = 5000;

export function serve(args?: string[]): void {
  const cliOptimize = args?.includes("--optimize") ?? false;
  const config = loadConfig();
  const optimize = cliOptimize || config.optimize.enabled;
  const registry = new SessionRegistry();
  const store = openStore(config.storage.dir);

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
    optimize ? { optimize: config.optimize } : undefined,
  );

  server.listen(config.server.port, config.server.host, () => {
    console.log(
      `aap proxy listening on http://${config.server.host}:${config.server.port}`,
    );
    console.log(`providers: ${Object.keys(config.providers).join(", ")}`);
    console.log(`storage: ${config.storage.dir}`);
    if (optimize) {
      const active = Object.entries(config.optimize)
        .filter(([k, v]) => v === true && k !== "enabled")
        .map(([k]) => k);
      console.log(`optimize: ON (${active.join(", ")})`);
    }
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

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("shutting down — draining in-flight requests...");
    clearInterval(parseTimer);

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
