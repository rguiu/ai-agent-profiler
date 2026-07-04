import { loadConfig } from "../config/index.js";
import { createProxyServer } from "../proxy/index.js";
import { SessionRegistry } from "../session/index.js";

export function serve(): void {
  const config = loadConfig();
  const registry = new SessionRegistry();
  const server = createProxyServer(config, registry);

  server.listen(config.server.port, config.server.host, () => {
    console.log(
      `aap proxy listening on http://${config.server.host}:${config.server.port}`,
    );
    console.log(`providers: ${Object.keys(config.providers).join(", ")}`);
  });
}
