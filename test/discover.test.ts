import { afterEach, describe, expect, it, mock } from "bun:test";
import type { NetworkInterfaceInfo } from "node:os";
import {
  discoverSupernote,
  enumerateCandidates,
  hostsForInterface,
  isMirrorHost,
} from "../src/discover.js";

const realFetch = globalThis.fetch;

describe("hostsForInterface", () => {
  it("expands a /24 into 254 host addresses, excluding network and broadcast", () => {
    const hosts = hostsForInterface("192.0.2.112", "255.255.255.0");
    expect(hosts).toHaveLength(253); // 254 usable minus self
    expect(hosts).toContain("192.0.2.1");
    expect(hosts).toContain("192.0.2.254");
    expect(hosts).not.toContain("192.0.2.0"); // network
    expect(hosts).not.toContain("192.0.2.255"); // broadcast
    expect(hosts).not.toContain("192.0.2.112"); // self
  });

  it("clamps an oversized range (e.g. /16) to the host's own /24", () => {
    const hosts = hostsForInterface("10.0.5.20", "255.255.0.0");
    expect(hosts.length).toBeLessThanOrEqual(254);
    expect(hosts).toContain("10.0.5.1");
    expect(hosts).toContain("10.0.5.254");
    expect(hosts).not.toContain("10.0.6.1");
  });
});

describe("enumerateCandidates", () => {
  it("collects external IPv4 hosts and skips internal/IPv6 interfaces", () => {
    const ifaces: Record<string, NetworkInterfaceInfo[]> = {
      lo0: [
        {
          address: "127.0.0.1",
          netmask: "255.0.0.0",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: true,
          cidr: "127.0.0.1/8",
        },
      ],
      en0: [
        {
          address: "192.0.2.50",
          netmask: "255.255.255.0",
          family: "IPv4",
          mac: "aa:bb:cc:dd:ee:ff",
          internal: false,
          cidr: "192.0.2.50/24",
        },
        {
          address: "fe80::1",
          netmask: "ffff:ffff:ffff:ffff::",
          family: "IPv6",
          mac: "aa:bb:cc:dd:ee:ff",
          internal: false,
          cidr: "fe80::1/64",
          scopeid: 0,
        },
      ],
    };
    const candidates = enumerateCandidates(ifaces);
    expect(candidates).toContain("192.0.2.1");
    expect(candidates).not.toContain("192.0.2.50"); // self
    expect(candidates).not.toContain("127.0.0.1"); // internal
  });
});

describe("discoverSupernote", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
    mock.restore();
  });

  it("returns the first candidate whose mirror endpoint serves a multipart stream", async () => {
    const fetchMock = mock(async (url: string | URL | Request) => {
      const target = url.toString();
      if (target.includes("192.0.2.7:8080")) {
        return new Response("", {
          status: 200,
          headers: { "content-type": "multipart/x-mixed-replace; boundary=x" },
        });
      }
      return new Response("nope", { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const found = await discoverSupernote({
      candidates: ["192.0.2.5", "192.0.2.7", "192.0.2.9"],
      port: 8080,
      concurrency: 4,
    });
    expect(found).toBe("192.0.2.7");
  });

  it("returns null when no candidate serves a multipart mirror stream", async () => {
    globalThis.fetch = mock(
      async () => new Response("no", { status: 404 }),
    ) as unknown as typeof fetch;

    const found = await discoverSupernote({
      candidates: ["192.0.2.5", "192.0.2.6"],
      port: 8080,
      concurrency: 4,
    });
    expect(found).toBeNull();
  });

  it("ignores hosts that serve port 8080 but are not the mirror (non-multipart)", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response("<html>printer</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    ) as unknown as typeof fetch;

    const found = await discoverSupernote({
      candidates: ["192.0.2.5"],
      port: 8080,
      concurrency: 4,
    });
    expect(found).toBeNull();
  });

  it("never exceeds the configured concurrency of in-flight probes", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    globalThis.fetch = mock(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return new Response("no", { status: 404 });
    }) as unknown as typeof fetch;

    const candidates = Array.from({ length: 50 }, (_, i) => `10.0.0.${i + 1}`);
    await discoverSupernote({ candidates, port: 8080, concurrency: 8 });
    expect(maxInFlight).toBeLessThanOrEqual(8);
  });

  it("stops probing once a match is found", async () => {
    let probed = 0;
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      probed++;
      if (url.toString().includes("10.0.0.1:8080")) {
        return new Response("", {
          status: 200,
          headers: { "content-type": "multipart/x-mixed-replace; boundary=x" },
        });
      }
      await new Promise((r) => setTimeout(r, 50));
      return new Response("no", { status: 404 });
    }) as unknown as typeof fetch;

    const candidates = Array.from({ length: 50 }, (_, i) => `10.0.0.${i + 1}`);
    const found = await discoverSupernote({ candidates, port: 8080, concurrency: 4 });
    expect(found).toBe("10.0.0.1");
    expect(probed).toBeLessThan(candidates.length); // not every host was reached
  });
});

describe("isMirrorHost", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
    mock.restore();
  });

  it("returns false (without throwing) when the shared signal aborts mid-probe", async () => {
    const controller = new AbortController();
    globalThis.fetch = mock(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    ) as unknown as typeof fetch;

    const probe = isMirrorHost("10.0.0.1", 8080, 5_000, controller.signal);
    controller.abort();
    expect(await probe).toBe(false);
  });
});
