export function applyCacheTtlUpgrade(parsed: Record<string, unknown>): boolean {
  let changed = false;
  const bump = (holder: Record<string, unknown> | undefined): void => {
    if (!holder) return;
    const cc = holder.cache_control as Record<string, unknown> | undefined;
    if (cc && cc.type === "ephemeral" && cc.ttl !== "1h") {
      cc.ttl = "1h";
      changed = true;
    }
  };
  if (Array.isArray(parsed.system)) {
    for (const b of parsed.system as Record<string, unknown>[]) bump(b);
  }
  if (Array.isArray(parsed.tools)) {
    for (const t of parsed.tools as Record<string, unknown>[]) bump(t);
  }
  if (Array.isArray(parsed.messages)) {
    for (const msg of parsed.messages as unknown[]) {
      const m = msg as { content?: unknown };
      if (Array.isArray(m.content)) {
        for (const b of m.content) bump(b as Record<string, unknown>);
      }
    }
  }
  return changed;
}

