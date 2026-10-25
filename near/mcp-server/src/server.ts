import { createInterface } from "node:readline";
import type { AgentTools } from "./tools.js";

interface JsonRpcRequest { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: unknown }

export class McpStdioServer {
  constructor(
    private readonly tools: AgentTools,
    private readonly input: NodeJS.ReadableStream = process.stdin,
    private readonly output: NodeJS.WritableStream = process.stdout,
  ) {}

  start(): void {
    const lines = createInterface({ input: this.input });
    lines.on("line", (line) => { void this.handleLine(line); });
  }

  async handle(request: JsonRpcRequest): Promise<Record<string, unknown> | null> {
    if (request.method === "notifications/initialized") return null;
    if (request.method === "initialize") return success(request.id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "air-otc-near", version: "0.1.0" },
    });
    if (request.method === "ping") return success(request.id, {});
    if (request.method === "tools/list") return success(request.id, { tools: this.tools.list() });
    if (request.method === "tools/call") {
      const params = object(request.params);
      try {
        const result = await this.tools.call(string(params.name), params.arguments ?? {});
        assertNoPrivateKeys(result);
        return success(request.id, { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result });
      } catch (error) {
        const message = safeError(error);
        return success(request.id, { content: [{ type: "text", text: message }], isError: true });
      }
    }
    return failure(request.id, -32601, "Method not found");
  }

  private async handleLine(line: string): Promise<void> {
    let response: Record<string, unknown> | null;
    try {
      if (line.length > 512 * 1024) throw new Error("Request too large");
      response = await this.handle(JSON.parse(line) as JsonRpcRequest);
    }
    catch { response = failure(null, -32700, "Parse error"); }
    if (response !== null) this.output.write(`${JSON.stringify(response)}\n`);
  }
}

function success(id: JsonRpcRequest["id"], result: unknown): Record<string, unknown> { return { jsonrpc: "2.0", id: id ?? null, result }; }
function failure(id: JsonRpcRequest["id"], code: number, message: string): Record<string, unknown> { return { jsonrpc: "2.0", id: id ?? null, error: { code, message } }; }
function object(value: unknown): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid parameters"); return value as Record<string, unknown>; }
function string(value: unknown): string { if (typeof value !== "string") throw new Error("Invalid tool name"); return value; }
function safeError(error: unknown): string { const message = error instanceof Error ? error.message : "Tool request failed"; return /^[A-Za-z0-9 _.:/-]{1,200}$/.test(message) ? message : "Tool request failed"; }

export function assertNoPrivateKeys(value: unknown): void {
  const forbidden = /^(privateKey|secretKey|signingSeed|boxSecretKey|rawToken|token|accessToken|bearerToken)$/i;
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) return candidate.forEach(visit);
    if (typeof candidate !== "object" || candidate === null) return;
    for (const [key, child] of Object.entries(candidate)) {
      if (forbidden.test(key)) throw new Error("Tool response contained forbidden secret material");
      visit(child);
    }
  };
  visit(value);
}
