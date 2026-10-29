/**
 * Where an agent dials the proxy.
 *
 * `[server].host` is a *bind* address. A wildcard (`0.0.0.0`, `::`) is not a
 * usable client target, so writing it into a client config hands the agent an
 * address it may not reach. Normalising it to loopback also keeps `aap route`
 * and `aap run` in agreement: `aap run` has always exported the loopback form,
 * and `aap route` compares an exported `OLLAMA_HOST` against this origin.
 */
export function clientHost(host: string): string {
  return host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
}

/** Origin an agent on this machine should use. */
export function proxyOrigin(server: {
  readonly host: string;
  readonly port: number;
}): string {
  return `http://${clientHost(server.host)}:${server.port}`;
}
