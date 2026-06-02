import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

const MIRROR_PATH = "/screencast.mjpeg";
const DEFAULT_PROBE_TIMEOUT_MS = 400;
const DEFAULT_CONCURRENCY = 32;
/** Never probe more than a /24 worth of hosts per interface. */
const MAX_HOSTS_PER_INTERFACE = 254;

function ipToInt(ip: string): number {
  return ip.split(".").reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

function intToIp(n: number): string {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join(".");
}

/**
 * Expand an interface's IPv4 address + netmask into the list of host IPs to
 * probe, excluding the network address, broadcast address, and the host itself.
 * Ranges larger than a /24 are clamped to the host's own /24 to keep scans bounded.
 */
export function hostsForInterface(address: string, netmask: string): string[] {
  const addr = ipToInt(address);
  let mask = ipToInt(netmask);
  // Clamp anything wider than /24 down to /24 around the host.
  const slash24 = ipToInt("255.255.255.0");
  if ((mask >>> 0) < (slash24 >>> 0)) mask = slash24;

  const network = (addr & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;

  const hosts: string[] = [];
  for (let h = network + 1; h < broadcast && hosts.length < MAX_HOSTS_PER_INTERFACE; h++) {
    if (h === addr) continue;
    hosts.push(intToIp(h));
  }
  return hosts;
}

/** Gather candidate host IPs from every external IPv4 interface on this machine. */
export function enumerateCandidates(
  ifaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): string[] {
  const out = new Set<string>();
  for (const addrs of Object.values(ifaces)) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      for (const host of hostsForInterface(a.address, a.netmask)) out.add(host);
    }
  }
  return [...out];
}

/**
 * Probe one host: is it serving the Supernote mirror (a multipart stream) on `port`?
 * Aborts on its own `timeoutMs`, or earlier if the caller's `signal` fires (e.g. once
 * another probe has already found the device).
 */
export async function isMirrorHost(
  host: string,
  port: number,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<boolean> {
  const controller = new AbortController();
  const onExternalAbort = (): void => controller.abort();
  const timer = setTimeout(onExternalAbort, timeoutMs);
  signal?.addEventListener("abort", onExternalAbort, { once: true });
  try {
    const res = await fetch(`http://${host}:${port}${MIRROR_PATH}`, {
      signal: controller.signal,
    });
    const contentType = res.headers.get("content-type") ?? "";
    controller.abort(); // we only needed the headers; don't drain the stream
    return res.ok && contentType.includes("multipart");
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onExternalAbort);
  }
}

export interface DiscoverOptions {
  port?: number;
  timeoutMs?: number;
  concurrency?: number;
  /** Override the candidate list (defaults to this machine's subnets). */
  candidates?: string[];
}

/**
 * Scan the local network for a host serving the Supernote mirror. Returns the
 * first matching IP, or null if none responds. Probes run concurrently and the
 * scan resolves as soon as a match is found.
 */
export async function discoverSupernote(opts: DiscoverOptions = {}): Promise<string | null> {
  const port = opts.port ?? 8080;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  const candidates = opts.candidates ?? enumerateCandidates();

  if (candidates.length === 0) return null;

  return new Promise<string | null>((resolve) => {
    // Shared signal so that finding a match cancels every other in-flight probe.
    const controller = new AbortController();
    let next = 0;
    let settled = 0;
    let done = false;

    // Each call processes exactly one host, then re-arms itself on completion.
    // Seeding `concurrency` of these holds the in-flight count at the limit.
    const launch = (): void => {
      if (done || next >= candidates.length) return;
      const host = candidates[next++]!;
      void isMirrorHost(host, port, timeoutMs, controller.signal).then((ok) => {
        settled++;
        if (done) return;
        if (ok) {
          done = true;
          controller.abort(); // stop the remaining in-flight probes
          resolve(host);
        } else if (settled === candidates.length) {
          resolve(null);
        } else {
          launch();
        }
      });
    };

    for (let i = 0; i < Math.min(concurrency, candidates.length); i++) launch();
  });
}
