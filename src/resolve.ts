import { discoverSupernote, type Probe } from "./discover.js";

/** Configured device address from an explicit value, then the SUPERNOTE_IP env var. */
export function configuredAddress(explicit?: string): string | undefined {
  return explicit?.trim() || process.env.SUPERNOTE_IP?.trim() || undefined;
}

/** Whether LAN discovery may be used as a fallback (disable with SUPERNOTE_DISCOVER=0). */
export function discoveryEnabled(override?: boolean): boolean {
  return override ?? process.env.SUPERNOTE_DISCOVER !== "0";
}

/**
 * Append the default port unless the address already carries one.
 * Supernote interfaces are IPv4-only, but this stays correct for bracketed IPv6
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

/** Caller-specific error wording, so each tool can keep its own actionable messages. */
export interface ResolveMessages {
  /** Configured address was reachable-attempted but the operation failed, and discovery is off. */
  unreachableConfigured: (host: string, cause: string) => string;
  /** No address configured and discovery is off. */
  noConfigDiscoverOff: () => string;
  /** Discovery ran (configured failed or absent) but found nothing. */
  scanFoundNothing: (configuredHost?: string) => string;
}

export interface ResolveOptions {
  /** Port the operation runs against (e.g. 8080 mirror, 8089 Browse & Access). */
  port: number;
  /** How discovery recognises the device on this port. */
  probe: Probe;
  /** LAN scanner used for the discovery fallback; defaults to {@link discoverSupernote}. Injectable for tests. */
  scan?: typeof discoverSupernote;
  /** Allow a LAN scan when the configured address is unreachable/absent. Defaults to SUPERNOTE_DISCOVER. */
  discover?: boolean;
  /**
   * Whether `op` is safe to re-run against a rediscovered device. Reads are (default
   * true); a write (upload) is not, because a *timeout* is ambiguous — the device may
   * have applied it — so we never retry a non-idempotent op after a timeout.
   */
  idempotent?: boolean;
  messages: ResolveMessages;
  /** Called with the discovered IP when a scan succeeds (e.g. to log "set SUPERNOTE_IP=…"). */
  onDiscovered?: (host: string) => void;
}

/**
 * Classify why an attempt against the configured address failed, so we only fall back
 * to a LAN scan for *reachability* problems (a stale/wrong IP) — never for a device
 * that answered and rejected the operation (HTTP 404, wrong path, parse failure):
 * rediscovering on those just wastes a scan and masks the real, actionable error.
 *
 * - `connect`: nothing answered (connection refused/reset/DNS) — undici/Bun raise a
 *   `TypeError`. The op definitely did not run, so retrying elsewhere is always safe.
 * - `timeout`: the host stopped responding (abort/`AbortError` or our own race timeout).
 *   Safe to retry for reads, but ambiguous for writes.
 * - `operational`: the device responded and we rejected it. Surface it as-is.
 */
function classifyFailure(err: unknown): "connect" | "timeout" | "operational" {
  const name = (err as { name?: string } | null)?.name;
  if (name === "AbortError" || name === "TimeoutError") return "timeout";
  if (err instanceof Error && /^Timed out after/.test(err.message)) return "timeout";
  if (err instanceof TypeError) return "connect";
  return "operational";
}

/**
 * Run `op` against the Supernote, resolving its address lazily: try the configured
 * address (arg → SUPERNOTE_IP) first; if it is *unreachable* — or none is set — fall
 * back to a LAN scan (unless discovery is disabled), then run `op` against the
 * discovered host. Operation-level failures from a device that did answer propagate
 * unchanged. `op` receives a `host:port` string; no device I/O happens until it runs.
 */
export async function withDeviceAddress<T>(
  ipArg: string | undefined,
  opts: ResolveOptions,
  op: (host: string) => Promise<T>,
): Promise<T> {
  const { port, messages } = opts;
  const canDiscover = discoveryEnabled(opts.discover);
  const idempotent = opts.idempotent ?? true;
  const configured = configuredAddress(ipArg);

  if (configured) {
    try {
      return await op(withPort(configured, port));
    } catch (err) {
      const kind = classifyFailure(err);
      // The device answered and refused the op — its own error is the useful one.
      if (kind === "operational") throw err;
      const retriable = kind === "connect" || (kind === "timeout" && idempotent);
      if (!canDiscover || !retriable) {
        throw new Error(
          messages.unreachableConfigured(withPort(configured, port), (err as Error).message),
          { cause: err },
        );
      }
      // Reachability failure with discovery enabled — fall through to a scan.
    }
  } else if (!canDiscover) {
    throw new Error(messages.noConfigDiscoverOff());
  }

  const found = await (opts.scan ?? discoverSupernote)({ port, probe: opts.probe });
  if (!found) {
    throw new Error(messages.scanFoundNothing(configured ? withPort(configured, port) : undefined));
  }
  opts.onDiscovered?.(found);
  return op(withPort(found, port));
}
