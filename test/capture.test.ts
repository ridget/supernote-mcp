import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

// Stand-ins the mocked modules delegate to, swapped per test.
let fetchMirrorFrameImpl: (ip: string) => Promise<{ toBase64: () => Promise<string> }>;
let discoverImpl: () => Promise<string | null>;
const fetchedHosts: string[] = [];

mock.module("supernote-typescript", () => ({
  fetchMirrorFrame: (ip: string) => {
    fetchedHosts.push(ip);
    return fetchMirrorFrameImpl(ip);
  },
  // Stubs so other modules that import these (e.g. note.ts) still link when this
  // mock is the active one; unused by the capture tests themselves.
  SupernoteX: class {
    pages: unknown[] = [];
    constructor(_bytes: Uint8Array) {}
  },
  toImage: async () => [],
}));
mock.module("../src/discover.js", () => ({
  discoverSupernote: () => discoverImpl(),
}));

// Import after the mocks are registered so capture.ts binds to them.
const { captureFrame, configuredAddress, withPort } = await import("../src/capture.js");

/** A fake image-js handle: `toBase64()` returns a PNG data URL, like the real one. */
function fakeImage(): { toBase64: () => Promise<string> } {
  return { toBase64: async () => "data:image/png;base64,AAAA" };
}

const ENV_KEY = "SUPERNOTE_IP";
const DISCOVER_KEY = "SUPERNOTE_DISCOVER";

describe("configuredAddress", () => {
  const original = process.env[ENV_KEY];
  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
  });

  it("prefers the explicit argument over the env var, trimmed", () => {
    process.env[ENV_KEY] = "10.0.0.9";
    expect(configuredAddress("  192.168.1.5  ")).toBe("192.168.1.5");
  });

  it("falls back to the env var when no argument is given", () => {
    process.env[ENV_KEY] = "10.0.0.9";
    expect(configuredAddress()).toBe("10.0.0.9");
  });

  it("returns undefined when both are empty/blank", () => {
    delete process.env[ENV_KEY];
    expect(configuredAddress("   ")).toBeUndefined();
  });
});

describe("withPort", () => {
  it("appends the default port to a bare IPv4 address", () => {
    expect(withPort("192.168.1.5", 8080)).toBe("192.168.1.5:8080");
  });

  it("leaves an address that already carries a port untouched", () => {
    expect(withPort("192.168.1.5:9090", 8080)).toBe("192.168.1.5:9090");
  });

  it("does not mistake a bare IPv6 literal's colons for a port", () => {
    expect(withPort("fe80::1", 8080)).toBe("[fe80::1]:8080");
  });

  it("appends a port to a bracketed IPv6 address without one", () => {
    expect(withPort("[::1]", 8080)).toBe("[::1]:8080");
  });

  it("leaves a bracketed IPv6 address that already has a port", () => {
    expect(withPort("[::1]:9090", 8080)).toBe("[::1]:9090");
  });
});

describe("captureFrame", () => {
  const originalIp = process.env[ENV_KEY];
  const originalDiscover = process.env[DISCOVER_KEY];

  beforeEach(() => {
    delete process.env[ENV_KEY];
    delete process.env[DISCOVER_KEY];
    fetchedHosts.length = 0;
    fetchMirrorFrameImpl = async () => fakeImage();
    discoverImpl = async () => null;
  });

  afterEach(() => {
    if (originalIp === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = originalIp;
    if (originalDiscover === undefined) delete process.env[DISCOVER_KEY];
    else process.env[DISCOVER_KEY] = originalDiscover;
  });

  it("fast path: captures from the configured address and never scans", async () => {
    let discoverCalled = false;
    discoverImpl = async () => {
      discoverCalled = true;
      return null;
    };

    const frame = await captureFrame("192.168.1.5");

    expect(frame.mimeType).toBe("image/png");
    expect(frame.base64).toBe("AAAA");
    expect(frame.data).toEqual(Buffer.from("AAAA", "base64"));
    expect(fetchedHosts).toEqual(["192.168.1.5:8080"]);
    expect(discoverCalled).toBe(false);
  });

  it("falls back to discovery when the configured address is unreachable", async () => {
    fetchMirrorFrameImpl = async (host) => {
      if (host.startsWith("192.168.1.5")) throw new Error("connection refused");
      return fakeImage();
    };
    discoverImpl = async () => "192.168.1.42";

    const frame = await captureFrame("192.168.1.5");

    expect(frame.base64).toBe("AAAA");
    expect(fetchedHosts).toEqual(["192.168.1.5:8080", "192.168.1.42:8080"]);
  });

  it("scans when no address is configured and discovery is enabled", async () => {
    discoverImpl = async () => "192.168.1.42";

    const frame = await captureFrame();

    expect(frame.base64).toBe("AAAA");
    expect(fetchedHosts).toEqual(["192.168.1.42:8080"]);
  });

  it("errors with the configured address when reachable fails and discovery is off", async () => {
    fetchMirrorFrameImpl = async () => {
      throw new Error("connection refused");
    };

    await expect(captureFrame("192.168.1.5", { discover: false })).rejects.toThrow(
      /Failed to capture a frame from the Supernote at 192\.168\.1\.5:8080.*connection refused/s,
    );
  });

  it("errors clearly when no address is set and discovery is off", async () => {
    await expect(captureFrame(undefined, { discover: false })).rejects.toThrow(
      /No Supernote IP provided and network discovery is disabled/,
    );
  });

  it("reports a scan-found-nothing error when nothing is configured", async () => {
    discoverImpl = async () => null;

    await expect(captureFrame()).rejects.toThrow(
      /No SUPERNOTE_IP was set, and a scan of the local network.*found no device/s,
    );
  });

  it("reports both the unreachable address and the empty scan when discovery fails", async () => {
    fetchMirrorFrameImpl = async () => {
      throw new Error("connection refused");
    };
    discoverImpl = async () => null;

    await expect(captureFrame("192.168.1.5")).rejects.toThrow(
      /Could not reach the Supernote at 192\.168\.1\.5:8080, and a scan.*found no device/s,
    );
  });

  it("respects SUPERNOTE_DISCOVER=0 as a discovery kill switch", async () => {
    process.env[DISCOVER_KEY] = "0";
    let discoverCalled = false;
    discoverImpl = async () => {
      discoverCalled = true;
      return "192.168.1.42";
    };

    await expect(captureFrame(undefined)).rejects.toThrow(/discovery is disabled/);
    expect(discoverCalled).toBe(false);
  });

  it("fails fast with a timeout error when the stream stalls", async () => {
    fetchMirrorFrameImpl = () => new Promise(() => {}); // never resolves

    await expect(
      captureFrame("192.168.1.5", { discover: false, timeoutMs: 10 }),
    ).rejects.toThrow(/Timed out after 10ms/);
  });
});
