#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { captureFrame } from "./capture.js";

const server = new McpServer({
  name: "supernote-mcp",
  version: "0.1.0",
});

server.registerTool(
  "supernote_snapshot",
  {
    title: "Supernote snapshot",
    description:
      "Capture what is currently drawn on the user's Supernote e-ink tablet (its live screen mirror) " +
      "and return it as an image. Call this whenever the user refers to something they sketched, drew, " +
      "diagrammed, or handwrote on their Supernote during a whiteboarding or planning session — for " +
      'example "what did I just draw?", "look at my sketch", or "read what I wrote". Requires Screen ' +
      "Mirroring enabled on the device, with the device and this host on the same Wi-Fi and no VPN/proxy.",
    inputSchema: {
      ip: z
        .string()
        .optional()
        .describe(
          "Device IP (optionally with :port) shown on the Supernote mirroring popup. " +
            "Defaults to the SUPERNOTE_IP environment variable.",
        ),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: true,
    },
  },
  async ({ ip }) => {
    try {
      const frame = await captureFrame(ip);
      return {
        content: [
          { type: "image", data: frame.base64, mimeType: frame.mimeType },
        ],
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          { type: "text", text: err instanceof Error ? err.message : String(err) },
        ],
      };
    }
  },
);

let closing = false;
const shutdown = (): void => {
  if (closing) return;
  closing = true;
  void server.close().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

try {
  const transport = new StdioServerTransport();
  await server.connect(transport);
} catch (err) {
  console.error(
    `[supernote-mcp] Failed to start: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}
