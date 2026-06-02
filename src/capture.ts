import { writeFileSync } from "node:fs";
import { fetchMirrorFrame } from "supernote-typescript";

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

/**
 * Resolve the device address from an explicit value, then the SUPERNOTE_IP env
 * var. Throws an actionable error if neither is set.
 */
export function resolveIp(explicit?: string): string {
  const ip = explicit?.trim() || process.env.SUPERNOTE_IP?.trim();
  if (!ip) {
    throw new Error(
      "No Supernote IP provided. Enable Screen Mirroring on the device (the popup shows an IP), " +
        "then pass it as the `ip` argument or set the SUPERNOTE_IP environment variable.",
    );
  }
  return ip;
}

/** Append the default mirror port unless the address already carries one. */
function withPort(address: string, port: number): string {
  return /:\d+$/.test(address) ? address : `${address}:${port}`;
}

export interface CaptureOptions {
  /** Mirror port, default 8080. Ignored if the IP already includes a port. */
  port?: number;
  /** Fail-fast timeout in ms, default 10000. */
  timeoutMs?: number;
}

/**
 * Capture the current Supernote screen-mirror frame.
 *
 * Lazy: performs no network I/O until called. Wraps
 * `supernote-typescript`'s `fetchMirrorFrame` (which has no timeout of its own)
 * with a fail-fast timeout and a clear, actionable error on failure.
 */
export async function captureFrame(
  ipArg?: string,
  opts: CaptureOptions = {},
): Promise<Frame> {
  const host = withPort(resolveIp(ipArg), opts.port ?? DEFAULT_PORT);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `Timed out after ${timeoutMs}ms waiting for a frame from ${host}.`,
          ),
        ),
      timeoutMs,
    );
  });

  try {
    const image = await Promise.race([fetchMirrorFrame(host), timeout]);
    const raw = await image.toBase64(); // image-js defaults to PNG
    const base64 = raw.replace(/^data:[^;]+;base64,/, "");
    return { data: Buffer.from(base64, "base64"), mimeType: "image/png", base64 };
  } catch (err) {
    throw new Error(
      `Failed to capture a frame from the Supernote at ${host}: ${(err as Error).message}. ` +
        "Check that the IP matches the device's mirroring popup, that Screen Mirroring is still on, " +
        "and that the device and this host share the same Wi-Fi with no VPN or proxy.",
      { cause: err },
    );
  } finally {
    clearTimeout(timer);
  }
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
