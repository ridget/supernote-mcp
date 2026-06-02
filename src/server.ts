#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { downloadFile, listFiles } from "./browse.js";
import { captureFrame } from "./capture.js";
import { extractText, parseNote, renderPages, selectPages } from "./note.js";

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

server.registerTool(
  "supernote_read_note",
  {
    title: "Read a Supernote note as text",
    description:
      "Read the recognized handwriting and typed text from a saved Supernote note (.note file) as " +
      "plain text. Call this when the user wants the CONTENTS of a specific note — e.g. \"read my " +
      'notes from yesterday", "summarise my meeting notes", "what did I write in <note>". Use ' +
      "supernote_list_files first to get the note's `path`. Returns recognized text per page — cheap " +
      "and accurate, so prefer it over images when the user wants the words. If the note has no " +
      "recognized text (on-device handwriting recognition wasn't run), it says so; use " +
      "supernote_render_note for page images instead. Requires Browse & Access enabled, same Wi-Fi, " +
      "no VPN/proxy.",
    inputSchema: {
      ip: ipSchema,
      path: z
        .string()
        .describe("The note's `path` from supernote_list_files, e.g. /Note/obsidian/meeting.note."),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: true,
    },
  },
  async ({ ip, path }) => {
    try {
      const bytes = await downloadFile(ip, path);
      const { pages, combinedText, hasText } = extractText(parseNote(bytes));
      if (!hasText) {
        return {
          content: [
            {
              type: "text",
              text:
                `This note has ${pages.length} page(s) but no recognized text — handwriting ` +
                "recognition hasn't been run on the device for it. Use supernote_render_note to get " +
                "the pages as images instead.",
            },
          ],
        };
      }
      return { content: [{ type: "text", text: combinedText }] };
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

server.registerTool(
  "supernote_render_note",
  {
    title: "Render Supernote note pages as images",
    description:
      "Render the pages of a saved Supernote note (.note file) as images. Call this when the user " +
      "wants to SEE a note — sketches, diagrams, drawings — or when supernote_read_note reported the " +
      "note has no recognized text. Use supernote_list_files first to get the note's `path`. By " +
      "default renders all pages (capped); pass `pages` to select specific 1-indexed pages. Prefer " +
      "supernote_read_note when the user only wants the words (text is far cheaper than images). " +
      "Requires Browse & Access enabled, same Wi-Fi, no VPN/proxy.",
    inputSchema: {
      ip: ipSchema,
      path: z
        .string()
        .describe("The note's `path` from supernote_list_files, e.g. /Note/obsidian/sketch.note."),
      pages: z
        .array(z.number().int().positive())
        .optional()
        .describe("1-indexed page numbers to render. Defaults to all pages (capped at 20)."),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: true,
    },
  },
  async ({ ip, path, pages }) => {
    try {
      const note = parseNote(await downloadFile(ip, path));
      const total = note.pages.length;
      const { pages: wanted, truncated } = selectPages(total, pages);
      if (wanted.length === 0) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `This note has ${total} page(s); the requested page numbers are out of range.`,
            },
          ],
        };
      }
      const rendered = await renderPages(note, wanted);
      const content: (
        | { type: "text"; text: string }
        | { type: "image"; data: string; mimeType: string }
      )[] = [];
      if (truncated) {
        content.push({
          type: "text",
          text: `Showing the first ${wanted.length} of ${total} pages. Pass \`pages\` to pick others.`,
        });
      }
      for (const r of rendered) {
        content.push({ type: "text", text: `Page ${r.page}:` });
        content.push({ type: "image", data: r.base64, mimeType: r.mimeType });
      }
      return { content };
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
