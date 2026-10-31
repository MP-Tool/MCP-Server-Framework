import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { rejectEncodedRequestBodies } from "./content-encoding.js";
import { createExpressApp } from "../http/express-app.js";
import { SessionManagerImpl } from "../session/index.js";

const BODY = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });

const servers: Server[] = [];
const disposers: Array<() => void> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  disposers.splice(0).forEach((dispose) => dispose());
});

async function listen(app: express.Application): Promise<string> {
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, "127.0.0.1", () => resolve(started));
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Minimal app: the middleware in front of the same json parser the framework mounts. */
async function startParserApp(): Promise<string> {
  const app = express();
  app.use(rejectEncodedRequestBodies);
  app.use(express.json());
  app.post("/echo", (req, res) => {
    res.json({ received: req.body as unknown });
  });
  return listen(app);
}

function post(baseUrl: string, path: string, body: Uint8Array | string, contentEncoding?: string): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (contentEncoding !== undefined) headers["content-encoding"] = contentEncoding;
  return fetch(`${baseUrl}${path}`, { method: "POST", headers, body });
}

describe("rejectEncodedRequestBodies", () => {
  it.each([
    ["br", brotliCompressSync(BODY)],
    ["gzip", gzipSync(BODY)],
    ["BR", brotliCompressSync(BODY)],
    ["identity, br", brotliCompressSync(BODY)],
  ])("rejects Content-Encoding %s with 415 before the body is parsed", async (encoding, payload) => {
    const baseUrl = await startParserApp();
    const response = await post(baseUrl, "/echo", payload, encoding);

    expect(response.status).toBe(415);
    expect(response.headers.get("accept-encoding")).toBe("identity");
    const body = (await response.json()) as { error?: { message?: string } };
    expect(body.error?.message).toMatch(/Content-Encoding not supported/);
  });

  it.each([[undefined], ["identity"], ["Identity"]])("passes Content-Encoding %s through", async (encoding) => {
    const baseUrl = await startParserApp();
    const response = await post(baseUrl, "/echo", BODY, encoding);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: JSON.parse(BODY) });
  });

  it("is mounted ahead of every route in the framework's Express app", async () => {
    const sessionManager = new SessionManagerImpl();
    disposers.push(() => sessionManager.dispose());
    let sessionsCreated = 0;
    const app = createExpressApp(() => {
      sessionsCreated++;
      throw new Error("an encoded body must never reach the MCP transport");
    }, sessionManager);
    const baseUrl = await listen(app);

    for (const path of ["/mcp", "/token", "/anything"]) {
      const response = await post(baseUrl, path, brotliCompressSync(BODY), "br");
      expect(response.status, path).toBe(415);
    }
    expect(sessionsCreated).toBe(0);
  });
});
