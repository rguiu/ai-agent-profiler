import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_DIR = fileURLToPath(new URL("../../web/", import.meta.url));

interface Asset {
  file: string;
  type: string;
}

const ROUTES: Record<string, Asset> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/ui": { file: "index.html", type: "text/html; charset=utf-8" },
  "/ui/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/ui/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/ui/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
};

export function handleUi(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): boolean {
  const asset = ROUTES[pathname];
  if (!asset) return false;

  if (req.method !== "GET") {
    res.writeHead(405, { "content-type": "text/plain" });
    res.end("method not allowed");
    return true;
  }

  let body: Buffer;
  try {
    body = readFileSync(join(WEB_DIR, asset.file));
  } catch {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(`UI asset not found: ${asset.file}`);
    return true;
  }

  res.writeHead(200, { "content-type": asset.type });
  res.end(body);
  return true;
}
