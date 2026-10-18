import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setup } from "../../../packages/engine/test/fakes.ts";
import { StrategyLibrary } from "../src/lib/library.ts";
import { createApp } from "../src/app.ts";

const rpc = (id: number | undefined, method: string, params?: unknown) => ({ jsonrpc: "2.0", ...(id !== undefined ? { id } : {}), method, ...(params ? { params } : {}) });

describe("MCP endpoint", () => {
  const t = setup();
  const catalog = { async list(product: string, o: { search?: string }) { return product === "perps" && /sol/i.test(o.search ?? "") ? [{ label: "SOL-PERP", name: "Solana", instrument: { kind: "perp", venue: "hyperliquid", symbol: "SOL" }, price: 103.2, change24hPct: -1.1, volume24hUsd: 9e8 }] : []; } };
  const app = createApp({ catalog: catalog as never, marketData: t.market, engine: t.engine, library: new StrategyLibrary(join(mkdtempSync(join(tmpdir(), "weft-mcp-")), "lib.db")), signalModes: {} });
  const post = async (body: unknown, headers: Record<string, string> = {}) => {
    const r = await app.request("/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(body) });
    return { status: r.status, // eslint-disable-next-line @typescript-eslint/no-explicit-any
      json: (r.status === 202 ? null : await r.json()) as any };
  };

  it("initializes, agreeing on a protocol version it knows", async () => {
    const r = await post(rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } }));
    expect(r.json.result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "weft" }, capabilities: { tools: {} } });
    expect(r.json.result.instructions).toMatch(/Nothing trades from this connection/);
    expect((await post(rpc(2, "initialize", { protocolVersion: "1999-01-01" }))).json.result.protocolVersion).toBe("2025-11-25");
    expect((await post(rpc(undefined, "notifications/initialized"))).status).toBe(202);
    expect((await app.request("/mcp")).status).toBe(405);
  });

  it("lists its tools with JSON schemas, all read-only", async () => {
    const { tools } = (await post(rpc(3, "tools/list"))).json.result;
    expect(tools.map((x: { name: string }) => x.name)).toEqual(["search_markets", "draft_strategy", "top_traders", "list_my_runs", "get_my_run"]);
    expect(tools[1].inputSchema).toMatchObject({ type: "object", required: ["idea"] });
    expect(tools.every((x: { annotations: { readOnlyHint: boolean } }) => x.annotations.readOnlyHint)).toBe(true);
  });

  it("searches markets", async () => {
    const r = (await post(rpc(4, "tools/call", { name: "search_markets", arguments: { query: "SOL" } }))).json.result;
    expect(r.content[0].text).toContain("SOL-PERP · 103.2 (-1.10% 24h)");
    expect(r.structuredContent.markets).toHaveLength(1);
  });

  it("drafts a strategy and links to it, without starting anything", async () => {
    const r = (await post(rpc(5, "tools/call", { name: "draft_strategy", arguments: { idea: "Long SOL 10x if it breaks $110" } }))).json.result;
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toMatch(/Nothing has been started\./);
    expect(r.structuredContent.url).toMatch(/^https:\/\/weft\.fi\/d\/[a-z0-9]+$/);
  });

  it("asks for a key before showing anyone's runs, and refuses bad arguments as tool errors", async () => {
    const r = (await post(rpc(6, "tools/call", { name: "list_my_runs", arguments: {} }))).json.result;
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/needs your Weft account/);
    const bad = (await post(rpc(7, "tools/call", { name: "draft_strategy", arguments: { idea: "" } }))).json.result;
    expect(bad.isError).toBe(true);
    expect((await post(rpc(8, "tools/call", { name: "nope" }))).json.error.code).toBe(-32602);
    expect((await post(rpc(9, "resources/list"))).json.error.code).toBe(-32601);
  });

  it("answers batches", async () => {
    const r = await post([rpc(10, "ping"), rpc(undefined, "notifications/initialized"), rpc(11, "tools/list")]);
    expect(r.json.map((x: { id: number }) => x.id)).toEqual([10, 11]);
  });
});
