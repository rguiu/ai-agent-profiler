export interface Route {
  sessionId: string | null;
  provider: string;
  upstreamPath: string;
}

export function parseRoute(
  pathname: string,
  providers: ReadonlySet<string>,
): Route | null {
  const trimmed = pathname.startsWith("/") ? pathname.slice(1) : pathname;
  if (trimmed.length === 0) return null;

  const firstSlash = trimmed.indexOf("/");
  const first = firstSlash === -1 ? trimmed : trimmed.slice(0, firstSlash);
  const afterFirst = firstSlash === -1 ? "" : trimmed.slice(firstSlash);

  if (providers.has(first)) {
    return {
      sessionId: null,
      provider: first,
      upstreamPath: afterFirst || "/",
    };
  }

  const rest = afterFirst.startsWith("/") ? afterFirst.slice(1) : afterFirst;
  if (rest.length === 0) return null;
  const secondSlash = rest.indexOf("/");
  const second = secondSlash === -1 ? rest : rest.slice(0, secondSlash);
  const afterSecond = secondSlash === -1 ? "" : rest.slice(secondSlash);
  if (!providers.has(second)) return null;

  return {
    sessionId: first,
    provider: second,
    upstreamPath: afterSecond || "/",
  };
}
