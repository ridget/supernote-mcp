#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { downloadFile, listFiles, uploadFile } from "./browse.js";
import { captureFrame } from "./capture.js";
import { extractText, parseNote, renderPages, selectPages } from "./note.js";

const server = new McpServer(
  {
    name: "supernote-mcp",
    version: "0.2.2",
  },
  {
    instructions: [
      "Tools to see and work with the user's Ratta Supernote e-ink tablet over the local network.",
      "",
      "Pick a tool by intent:",
      "- The live screen right now (user is sketching/whiteboarding, \"what did I just draw?\"): supernote_snapshot.",
      "- Find a saved notebook or file: supernote_list_files — returns each entry's `path`.",
      "- Read a saved note's words: supernote_read_note — recognized handwriting as text. Cheap and accurate; prefer it when the user wants the content.",
      "- See a saved note's pages (sketches/diagrams, or when read_note reports no recognized text): supernote_render_note.",
      "- Put a file onto the device: supernote_upload_file — the only tool that writes to the tablet.",
      "",
      "Saved-note flow: supernote_list_files → take the entry's `path` → supernote_read_note (text) or supernote_render_note (images). supernote_snapshot is the current screen, not a saved file.",
      "Setup: the device and this host must share Wi-Fi (no VPN). Set SUPERNOTE_IP or let discovery find it. Screen Mirroring (for snapshot) and Browse & Access (for the file/note tools) are separate features the user toggles on the device; a tool fails clearly if its feature is off.",
    ].join("\n"),
  },
);

server.registerTool(
  "supernote_snapshot",
  {
    title: "Supernote snapshot",
    description:
      "Capture the user's Supernote e-ink tablet's LIVE screen right now (its screen mirror) and " +
      "return it as an image. Call this when the user refers to what's currently on the tablet — what " +
      'they just sketched, drew, or handwrote during a whiteboarding/planning session ("what did I ' +
      'just draw?", "look at my screen", "see my sketch"). This is the current screen, NOT a saved ' +
      "file: to read or show a notebook saved earlier, use supernote_list_files then " +
      "supernote_read_note (text) or supernote_render_note (images). Requires Screen Mirroring enabled " +
      "on the device, with the device and this host on the same Wi-Fi and no VPN/proxy.",
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

server.registerTool(
  "supernote_upload_file",
  {
    title: "Upload a file to the Supernote",
    description:
      "Upload a local file to the user's Supernote e-ink tablet over its Browse & Access Wi-Fi " +
      "server. Use this to put a document on the device for the user to read or annotate — e.g. a " +
      "PDF or file the agent just created or downloaded. This WRITES to the device. Give the local " +
      "file `path`; optionally a target `directory` on the device (a `path` from supernote_list_files, " +
      "default root) and a `filename` to save as (default: the local file's name). Requires Browse & " +
      "Access enabled, same Wi-Fi, no VPN/proxy.",
    inputSchema: {
      ip: ipSchema,
      path: z.string().describe("Local filesystem path of the file to upload."),
      directory: z
        .string()
        .optional()
        .describe("Target folder on the device (a `path` from supernote_list_files). Defaults to the root."),
      filename: z
        .string()
        .optional()
        .describe("Name to save the file as on the device. Defaults to the local file's name."),
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: true,
    },
  },
  async ({ ip, path, directory, filename }) => {
    try {
      const bytes = readFileSync(path);
      const name = filename ?? basename(path);
      const dir = directory ?? "/";
      await uploadFile(ip, dir, name, bytes);
      return {
        content: [
          {
            type: "text",
            text: `Uploaded "${name}" (${bytes.length} bytes) to ${dir === "/" ? "the device root" : dir}.`,
          },
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
