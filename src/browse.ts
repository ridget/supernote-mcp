import { writeFileSync } from "node:fs";
import { isBrowseHost } from "./discover.js";
import { withDeviceAddress, type ResolveMessages } from "./resolve.js";

const DEFAULT_PORT = 8089;
const DEFAULT_TIMEOUT_MS = 10_000;
/** Refuse downloads larger than this, so a wrong path can't stream forever. */
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

/** One entry in a Browse & Access directory listing. */
export interface FileEntry {
  /** Display name, e.g. "Meeting.note". */
  name: string;
  /** True for a folder, false for a file. */
  isDirectory: boolean;
  /** Path used to fetch/descend, relative to the server root (may be URL-encoded). */
  uri: string;
  /** File extension without a dot, e.g. "note" or "pdf" (empty for folders). */
  extension: string;
  /** Size in bytes. */
  size: number;
  /** Last-modified, "YYYY-MM-DD HH:MM" as reported by the device. */
  date: string;
}

export interface BrowseOptions {
  /** Browse & Access port, default 8089. */
  port?: number;
  /** Fail-fast timeout in ms, default 10000. */
  timeoutMs?: number;
  /** Allow a LAN scan when the configured address is unreachable/absent. Defaults to SUPERNOTE_DISCOVER. */
  discover?: boolean;
}

function browseMessages(port: number): ResolveMessages {
  return {
    unreachableConfigured: (host, cause) =>
      `Could not reach the Supernote's Browse & Access server at ${host}: ${cause}. ` +
      "Check the IP, that Browse & Access is enabled on the device (swipe down from the top, tap " +
      "Browse & Access), and that the device and this host share the same Wi-Fi with no VPN or proxy.",
    noConfigDiscoverOff: () =>
      "No Supernote IP provided and network discovery is disabled. Enable Browse & Access on the " +
      "device (the popup shows an IP), then pass it as the `ip` argument or set SUPERNOTE_IP.",
    scanFoundNothing: (configuredHost) =>
      (configuredHost
        ? `Could not reach the Supernote at ${configuredHost}, and a scan of the local network `
        : "No SUPERNOTE_IP was set, and a scan of the local network ") +
      `found no device serving Browse & Access on port ${port}. ` +
      "Check that Browse & Access is enabled and that this host shares the device's Wi-Fi with no VPN or proxy.",
  };
}

function onDiscovered(found: string): void {
  console.error(
    `[supernote-mcp] Discovered Supernote at ${found}. Set SUPERNOTE_IP=${found} to skip the scan next time.`,
  );
}

/** Strip leading slashes so a server-relative path joins cleanly onto the base URL. */
function joinPath(host: string, path: string): string {
  return `http://${host}/${path.replace(/^\/+/, "")}`;
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The listing page embeds its data as `const json = '{...}'`. JSON uses double
 * quotes, so the single-quote delimiters are unambiguous; the non-greedy `}'`
 * terminator only matches the real end of the object. (A filename containing `}'`
 * would defeat this — a limitation shared with other Browse & Access clients.)
 */
function extractListingJson(html: string): string {
  const match = html.match(/const\s+json\s*=\s*'(\{[\s\S]*?\})'/);
  if (!match?.[1]) {
    throw new Error(
      "Could not find the file listing in the Browse & Access response — the device firmware's " +
        "page format may differ from what this client expects.",
    );
  }
  return match[1];
}

/** List a directory on the device. `path` is relative to the Browse & Access root ("/" = root). */
export async function listFiles(
  ipArg?: string,
  path = "/",
  opts: BrowseOptions = {},
): Promise<FileEntry[]> {
  const port = opts.port ?? DEFAULT_PORT;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return withDeviceAddress(
    ipArg,
    { port, probe: isBrowseHost, discover: opts.discover, messages: browseMessages(port), onDiscovered },
    async (host) => {
      const res = await fetchWithTimeout(joinPath(host, path), timeoutMs);
      if (!res.ok) throw new Error(`Browse & Access returned HTTP ${res.status} for "${path}".`);
      const parsed = JSON.parse(extractListingJson(await res.text())) as {
        fileList?: Partial<FileEntry>[];
      };
      return (parsed.fileList ?? []).map((f) => ({
        name: f.name ?? "",
        isDirectory: Boolean(f.isDirectory),
        uri: f.uri ?? "",
        extension: f.extension ?? "",
        size: Number(f.size ?? 0),
        date: f.date ?? "",
      }));
    },
  );
}

/** Download a file by its `uri` (as given in a listing entry). Returns the raw bytes. */
export async function downloadFile(
  ipArg: string | undefined,
  uri: string,
  opts: BrowseOptions = {},
): Promise<Buffer> {
  const port = opts.port ?? DEFAULT_PORT;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return withDeviceAddress(
    ipArg,
    { port, probe: isBrowseHost, discover: opts.discover, messages: browseMessages(port), onDiscovered },
    async (host) => {
      const res = await fetchWithTimeout(joinPath(host, uri), timeoutMs);
      if (!res.ok) throw new Error(`Browse & Access returned HTTP ${res.status} for "${uri}".`);
      const contentType = res.headers.get("content-type") ?? "";
      if (contentType.includes("text/html")) {
        throw new Error(
          `Expected a file at "${uri}" but the device returned an HTML page — the path may be stale ` +
            "or a directory. List the parent directory and use the entry's `uri`.",
        );
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > MAX_DOWNLOAD_BYTES) {
        throw new Error(`File at "${uri}" exceeds the ${MAX_DOWNLOAD_BYTES}-byte download limit.`);
      }
      return bytes;
    },
  );
}

/**
 * CLI for local verification:
 *   bun src/browse.ts list --ip <ip[:port]> [--path /]
 *   bun src/browse.ts get  --ip <ip[:port]> --path <uri> --out <file>
 */
async function main(argv: string[]): Promise<void> {
  const cmd = argv[0];
  let ip: string | undefined;
  let path = "/";
  let out = "";
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--ip") ip = argv[++i];
    else if (argv[i] === "--path") path = argv[++i] ?? path;
    else if (argv[i] === "--out") out = argv[++i] ?? out;
  }

  if (cmd === "list") {
    const entries = await listFiles(ip, path);
    for (const e of entries) {
      console.error(
        `${e.isDirectory ? "d" : "-"} ${String(e.size).padStart(9)}  ${e.date}  ${e.name}  (${e.uri})`,
      );
    }
    console.error(`${entries.length} ent`.concat(entries.length === 1 ? "ry" : "ries"));
  } else if (cmd === "get") {
    if (!out) throw new Error("get requires --out <file>");
    const bytes = await downloadFile(ip, path);
    writeFileSync(out, bytes);
    console.error(`Downloaded ${bytes.length} bytes -> ${out}`);
  } else {
    throw new Error("usage: browse.ts <list|get> --ip <ip> [--path <p>] [--out <f>]");
  }
}

const entry = process.argv[1] ?? "";
const isBrowseCli = /(?:^|\/)browse(?:\.[cm]?[jt]s)?$/.test(entry);
if (isBrowseCli) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
