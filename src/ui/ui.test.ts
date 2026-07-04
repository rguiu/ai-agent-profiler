import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { handleUi } from "./index.js";

let server: http.Server | undefined;

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

async function start(): Promise<number> {
  server = http.createServer((req, res) => {
    const pathname = (req.url ?? "/").split("?")[0] ?? "/";
    if (handleUi(req, res, pathname)) return;
    res.writeHead(404);
    res.end("nope");
  });
  return new Promise((resolve) => {
    server!.listen(0, "127.0.0.1", () =>
      resolve((server!.address() as AddressInfo).port),
    );
  });
}

describe("handleUi", () => {
  it("serves the dashboard HTML at / and /ui", async () => {
    const port = await start();
    for (const path of ["/", "/ui"]) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toContain("AI Agent Profiler");
    }
  });

  it("serves the app script and stylesheet with correct types", async () => {
    const port = await start();
    const js = await fetch(`http://127.0.0.1:${port}/ui/app.js`);
    expect(js.headers.get("content-type")).toContain("javascript");
    expect(await js.text()).toContain("dashboard");

    const css = await fetch(`http://127.0.0.1:${port}/ui/styles.css`);
    expect(css.headers.get("content-type")).toContain("text/css");
  });

  it("passes through non-UI paths (returns false)", async () => {
    const port = await start();
    const res = await fetch(`http://127.0.0.1:${port}/sessions`);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("nope");
  });
});
