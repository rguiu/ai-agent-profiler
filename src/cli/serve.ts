import { FileCapture } from "../capture/index.js";
import { loadConfig } from "../config/index.js";
import { runParse } from "../parse/index.js";
import { consoleRequestLogger, createProxyServer } from "../proxy/index.js";
import { SessionRegistry } from "../session/index.js";
import { openStore } from "../store/index.js";

const PARSE_INTERVAL_MS = 3000;

export function serve(): void {
  const config = loadConfig();
  const registry = new SessionRegistry();
  const store = openStore(config.storage.dir);
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

  server.listen(config.server.port, config.server.host, () => {
    console.log(
      `aap proxy listening on http://${config.server.host}:${config.server.port}`,
    );
    console.log(`providers: ${Object.keys(config.providers).join(", ")}`);
    console.log(`storage: ${config.storage.dir}`);
  });

  // Capture stays on the hot path; parsing runs on a background tick so that
  // finished requests turn into metrics/tool calls without a manual `aap parse`.
  const parseTimer = setInterval(() => {
    try {
      const summary = runParse(store, config.pricing, { all: false });
      if (summary.parsed > 0) {
        console.log(`parsed ${summary.parsed} request(s)`);
      }
    } catch (err) {
      console.error(`background parse failed: ${(err as Error).message}`);
    }
  }, PARSE_INTERVAL_MS);
  parseTimer.unref();

  const shutdown = (): void => {
    clearInterval(parseTimer);
    server.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
