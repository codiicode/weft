import { z } from "zod";

/**
 * Weft as an MCP server (Model Context Protocol), so Claude, ChatGPT, Cursor and other AI
 * assistants can use it: search markets, draft a strategy from an idea, read your runs.
 *
 * Transport: Streamable HTTP, stateless. Every JSON-RPC message is a POST to /mcp answered with
 * plain JSON (no session, no server-sent stream: nothing here needs to push). GET is refused (405),
 * as the spec allows for servers without a stream.
 *
 * Nothing trades from here. A draft opens in Weft, where its owner reads it and presses start, the
 * same rule as everywhere else ("nothing happens until you say yes").
 */

export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;

export interface ToolResult {
  text: string;
  data?: unknown;
  isError?: boolean;
}

export interface Tool<C> {
  name: string;
  title: string;
  description: string;
  input: z.ZodObject;
  /** Shown as hints to the client: none of Weft's tools change anything outside Weft. */
  readOnly: boolean;
  call: (args: never, ctx: C) => Promise<ToolResult>;
}

export class ToolError extends Error {}

type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: Record<string, unknown> };
type Reply = { jsonrpc: "2.0"; id: string | number | null; result?: unknown; error?: { code: number; message: string; data?: unknown } };

const ok = (id: Rpc["id"], result: unknown): Reply => ({ jsonrpc: "2.0", id: id ?? null, result });
const fail = (id: Rpc["id"], code: number, message: string): Reply => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/** Answers one JSON-RPC message (null for notifications, which get no answer). */
export async function handleRpc<C>(msg: Rpc, tools: Tool<C>[], ctx: C, info: { name: string; version: string; instructions: string }): Promise<Reply | null> {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return fail(msg?.id, -32600, "invalid request");
  const isNote = msg.id === undefined;
  switch (msg.method) {
    case "initialize": {
      const asked = String(msg.params?.protocolVersion ?? "");
      return ok(msg.id, {
        protocolVersion: (PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: info.name, title: "Weft", version: info.version },
        instructions: info.instructions,
      });
    }
    case "ping":
      return isNote ? null : ok(msg.id, {});
    case "tools/list":
      return ok(msg.id, {
        tools: tools.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: z.toJSONSchema(t.input, { target: "draft-7", io: "input" }),
          annotations: { title: t.title, readOnlyHint: t.readOnly, destructiveHint: false, openWorldHint: true },
        })),
      });
    case "tools/call": {
      const tool = tools.find((t) => t.name === msg.params?.name);
      if (!tool) return fail(msg.id, -32602, `unknown tool: ${String(msg.params?.name)}`);
      const parsed = tool.input.safeParse(msg.params?.arguments ?? {});
      if (!parsed.success) return ok(msg.id, { content: [{ type: "text", text: `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}` }], isError: true });
      try {
        const r = await tool.call(parsed.data as never, ctx);
        return ok(msg.id, { content: [{ type: "text", text: r.text }], ...(r.data !== undefined ? { structuredContent: r.data } : {}), ...(r.isError ? { isError: true } : {}) });
      } catch (e) {
        // Tool failures go back to the model as results it can read and explain, not protocol errors.
        return ok(msg.id, { content: [{ type: "text", text: (e as Error).message || "Something went wrong." }], isError: true });
      }
    }
    default:
      if (isNote) return null; // notifications/initialized, notifications/cancelled, …
      return fail(msg.id, -32601, `method not found: ${msg.method}`);
  }
}
