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

/**
 * Hostname that identifies one launcher session.
 *
 * `OLLAMA_HOST` carries no path, so an agent ollama starts cannot send a
 * `/session/provider` prefix, and loopback IP aliases (`127.0.0.x`) need root
 * on macOS. RFC 6761 reserves the `.localhost` TLD for loopback, so the session
 * id can ride in the hostname and needs no configuration. Not every resolver
 * honours it (plain glibc without systemd-resolved does not), so `aap run`
 * probes the name and falls back to pinning the session when it doesn't
 * resolve.
 */
export function ollamaAliasHostname(sessionId: string): string {
  const label =
    sessionId
      .toLowerCase()
      .replace(/[^a-z0-9.-]/g, "-")
      .slice(0, 63) || "session";
  return `${label}.localhost`;
}
