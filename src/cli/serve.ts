import { FileCapture } from "../capture/index.js";
import { loadConfig } from "../config/index.js";
import { consoleRequestLogger, createProxyServer } from "../proxy/index.js";
import { SessionRegistry } from "../session/index.js";
import { openStore } from "../store/index.js";

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

  const shutdown = (): void => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
