import { writeFileSync } from "node:fs";
import { fetchMirrorFrame } from "supernote-typescript";
import { discoverSupernote } from "./discover.js";

/** A single captured frame from the Supernote screen mirror. */
export interface Frame {
  /** Raw image bytes (PNG). */
  data: Buffer;
  /** Always "image/png" — image-js re-encodes the decoded frame to PNG. */
  mimeType: string;
  /** Base64-encoded PNG, ready for MCP image content. */
  base64: string;
}

const DEFAULT_PORT = 8080;
const DEFAULT_TIMEOUT_MS = 10_000;

/** Configured device address from an explicit value, then the SUPERNOTE_IP env var. */
export function configuredAddress(explicit?: string): string | undefined {
  return explicit?.trim() || process.env.SUPERNOTE_IP?.trim() || undefined;
}

/** Whether LAN discovery may be used as a fallback (disable with SUPERNOTE_DISCOVER=0). */
export function discoveryEnabled(override?: boolean): boolean {
  return override ?? process.env.SUPERNOTE_DISCOVER !== "0";
}

/**
 * Append the default mirror port unless the address already carries one.
 * Supernote mirroring is IPv4-only, but this stays correct for bracketed IPv6
 * (`[::1]` / `[::1]:8080`) and brackets a bare IPv6 literal before adding a port,
 * so a stray colon in an address is never mistaken for a port separator.
 */
export function withPort(address: string, port: number): string {
  if (address.startsWith("[")) {
    // Bracketed IPv6: a port is present only as `]:<digits>`.
    return /]:\d+$/.test(address) ? address : `${address}:${port}`;
  }
  if (address.indexOf(":") !== address.lastIndexOf(":")) {
    // Bare IPv6 (more than one colon): bracket it so the port is unambiguous.
    return `[${address}]:${port}`;
  }
  // IPv4 or hostname, optionally already suffixed with `:<port>`.
  return /:\d+$/.test(address) ? address : `${address}:${port}`;
}

export interface CaptureOptions {
  /** Mirror port, default 8080. Ignored if the IP already includes a port. */
  port?: number;
  /** Fail-fast timeout in ms, default 10000. */
  timeoutMs?: number;
  /** Allow a LAN scan when the configured address is unreachable/absent. Defaults to SUPERNOTE_DISCOVER. */
  discover?: boolean;
}

/**
 * Fetch and decode a single frame from `host` (`ip:port`), with a fail-fast timeout.
 *
 * The timeout makes the caller fail fast, but cannot cancel the work: upstream
 * `fetchMirrorFrame` opens its own connection with a private AbortController and
 * exposes no signal, so a stalled stream keeps its socket until the process exits
 * or the device closes it. Acceptable for one-shot snapshots; revisit if the
 * upstream API ever accepts an `AbortSignal`.
 */
async function grabFrame(host: string, timeoutMs: number): Promise<Frame> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timed out after ${timeoutMs}ms waiting for a frame from ${host}.`)),
      timeoutMs,
    );
  });
  try {
    const image = await Promise.race([fetchMirrorFrame(host), timeout]);
    const raw = await image.toBase64(); // image-js defaults to PNG
    const base64 = raw.replace(/^data:[^;]+;base64,/, "");
    return { data: Buffer.from(base64, "base64"), mimeType: "image/png", base64 };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Capture the current Supernote screen-mirror frame.
 *
 * Lazy: performs no network I/O until called. Tries the configured address
 * (arg → SUPERNOTE_IP) first; if that is unreachable — or absent — it falls back
 * to scanning the local network for the mirror (unless discovery is disabled),
 * and reports the discovered IP so the user can pin it.
 */
export async function captureFrame(
  ipArg?: string,
  opts: CaptureOptions = {},
): Promise<Frame> {
  const port = opts.port ?? DEFAULT_PORT;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const canDiscover = discoveryEnabled(opts.discover);
  const configured = configuredAddress(ipArg);

  // Fast path: the configured address.
  if (configured) {
    try {
      return await grabFrame(withPort(configured, port), timeoutMs);
    } catch (err) {
      if (!canDiscover) {
        throw new Error(
          `Failed to capture a frame from the Supernote at ${withPort(configured, port)}: ${(err as Error).message}. ` +
            "Check that the IP matches the device's mirroring popup, that Screen Mirroring is still on, " +
            "and that the device and this host share the same Wi-Fi with no VPN or proxy.",
          { cause: err },
        );
      }
      // fall through to discovery
    }
  } else if (!canDiscover) {
    throw new Error(
      "No Supernote IP provided and network discovery is disabled. Enable Screen Mirroring on the " +
        "device (the popup shows an IP), then pass it as the `ip` argument or set SUPERNOTE_IP.",
    );
  }

  // Fallback: scan the LAN for the mirror.
  const found = await discoverSupernote({ port });
  if (!found) {
    throw new Error(
      (configured
        ? `Could not reach the Supernote at ${withPort(configured, port)}, and a scan of the local network `
        : "No SUPERNOTE_IP was set, and a scan of the local network ") +
        `found no device serving the mirror on port ${port}. ` +
        "Check that Screen Mirroring is on and that this host shares the device's Wi-Fi with no VPN or proxy.",
    );
  }
  console.error(
    `[supernote-mcp] Discovered Supernote at ${found}. Set SUPERNOTE_IP=${found} to skip the scan next time.`,
  );
  return grabFrame(withPort(found, port), timeoutMs);
}

/**
 * CLI for local verification:
 *   bun src/capture.ts --ip <ip[:port]> --out frame.png
 */
async function main(argv: string[]): Promise<void> {
  let ip: string | undefined;
  let out = "frame.png";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--ip") ip = argv[++i];
    else if (argv[i] === "--out") out = argv[++i] ?? out;
  }

  const frame = await captureFrame(ip);
  writeFileSync(out, frame.data);
  console.error(
    `Captured ${frame.data.length} bytes (${frame.mimeType}) -> ${out}`,
  );
}

// Only run the CLI when this file is the invoked entry (e.g. `bun src/capture.ts`).
// Keyed on the entry filename rather than `import.meta.url` so it stays dormant
// once bundled into the server (where the inlined module shares the entry URL).
const entry = process.argv[1] ?? "";
const isCaptureCli = /(?:^|\/)capture(?:\.[cm]?[jt]s)?$/.test(entry);
if (isCaptureCli) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
