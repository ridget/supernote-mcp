#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { listFiles } from "./browse.js";
import { captureFrame } from "./capture.js";

const server = new McpServer({
  name: "supernote-mcp",
  version: "0.1.1",
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

const ipSchema = z
  .string()
  .optional()
  .describe(
    "Device IP (optionally with :port) shown on the Supernote's mirroring or Browse & Access popup. " +
      "Defaults to the SUPERNOTE_IP environment variable; if unset, the device is found by a LAN scan.",
  );

server.registerTool(
  "supernote_list_files",
  {
    title: "List Supernote files",
    description:
      "List the notebooks, documents, and folders saved on the user's Supernote e-ink tablet, over " +
      "its Browse & Access Wi-Fi file server. Call this to find a saved note before reading or " +
      "rendering it — for example when the user says \"read my notes from yesterday\" or \"what's on " +
      'my Supernote?". Returns each entry\'s name, whether it is a folder, size, date, and a `path` ' +
      "to pass to supernote_read_note / supernote_render_note (or back into this tool to descend into " +
      "a folder). Requires Browse & Access enabled on the device (swipe down → Browse & Access), same " +
      "Wi-Fi, no VPN/proxy.",
    inputSchema: {
      ip: ipSchema,
      path: z
        .string()
        .optional()
        .describe("Folder to list, as a `path`/`uri` from a previous listing. Defaults to the root."),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: true,
    },
  },
  async ({ ip, path }) => {
    try {
      const entries = await listFiles(ip, path ?? "/");
      if (entries.length === 0) {
        return { content: [{ type: "text", text: "No files found in this location." }] };
      }
      const lines = entries.map((e) =>
        [
          e.isDirectory ? "[dir] " : "[file]",
          e.name,
          e.isDirectory ? "" : `${e.size} bytes`,
          e.date,
          `path=${e.uri}`,
        ]
          .filter(Boolean)
          .join("  "),
      );
      return { content: [{ type: "text", text: lines.join("\n") }] };
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
