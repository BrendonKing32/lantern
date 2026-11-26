import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShapeOutput, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export const DATA_OUTPUT_SCHEMA = { result: z.unknown() };

export function recordOAuthMetric(metric: {
  operation: string;
  outcome: "ok" | "error";
  status: number;
  duration_ms: number;
  response_bytes: number;
}) {
  console.log(JSON.stringify({ event: "mcp_oauth", ...metric }));
}

export function dataResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 1) }],
    structuredContent: { result: value },
  };
}

export function registerConnectorTool<Args extends ZodRawShapeCompat>(
  server: McpServer,
  name: string,
  config: {
    title?: string;
    description?: string;
    inputSchema: Args;
    outputSchema?: ZodRawShapeCompat;
    annotations?: ToolAnnotations;
    _meta?: Record<string, unknown>;
  },
  callback: ToolCallback<Args>,
) {
  const trackedCallback = async (
    args: ShapeOutput<Args>,
    extra: Parameters<ToolCallback<Args>>[1],
  ) => {
    const started = performance.now();
    try {
      const result = await callback(args, extra);
      const responseBytes = new TextEncoder().encode(
        JSON.stringify({ content: result.content, structuredContent: result.structuredContent }) ?? "",
      ).length;
      console.log(JSON.stringify({
        event: "mcp_tool",
        tool: name,
        outcome: result.isError ? "error" : "ok",
        duration_ms: Math.round(performance.now() - started),
        response_bytes: responseBytes,
      }));
      return result;
    } catch (error) {
      console.log(JSON.stringify({
        event: "mcp_tool",
        tool: name,
        outcome: "error",
        duration_ms: Math.round(performance.now() - started),
        response_bytes: 0,
      }));
      throw error;
    }
  };
  return server.registerTool<ZodRawShapeCompat, Args>(name, config, trackedCallback as ToolCallback<Args>);
}
