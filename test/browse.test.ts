import { afterEach, describe, expect, it, mock } from "bun:test";
import { downloadFile, listFiles } from "../src/browse.js";

const realFetch = globalThis.fetch;
const NO_DISCOVER = { discover: false } as const;

/** Build a Browse & Access listing page: HTML with the data embedded as `const json = '…'`. */
function listingHtml(data: unknown): string {
  return `<!DOCTYPE html><html><body><script>const json = '${JSON.stringify(data)}';</script></body></html>`;
}

function htmlResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
}

afterEach(() => {
  globalThis.fetch = realFetch;
  mock.restore();
});

describe("listFiles", () => {
  it("parses the embedded JSON listing into typed entries", async () => {
    globalThis.fetch = mock(async () =>
      htmlResponse(
        listingHtml({
          deviceName: "MyNote",
          fileList: [
            { isDirectory: true, uri: "Note", extension: "", date: "2026-01-02 10:00", size: 0, name: "Note" },
            {
              isDirectory: false,
              uri: "Note/meeting.note",
              extension: "note",
              date: "2026-01-03 12:00",
              size: 4096,
              name: "meeting.note",
            },
          ],
        }),
      ),
    ) as unknown as typeof fetch;

    const entries = await listFiles("192.0.2.10", "/", NO_DISCOVER);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ name: "Note", isDirectory: true, uri: "Note" });
    expect(entries[1]).toMatchObject({
      name: "meeting.note",
      isDirectory: false,
      uri: "Note/meeting.note",
      extension: "note",
      size: 4096,
      date: "2026-01-03 12:00",
    });
  });

  it("requests the given directory path against port 8089", async () => {
    const seen: string[] = [];
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      seen.push(url.toString());
      return htmlResponse(listingHtml({ fileList: [] }));
    }) as unknown as typeof fetch;

    await listFiles("192.0.2.10", "/Note/Sub", NO_DISCOVER);
    expect(seen[0]).toBe("http://192.0.2.10:8089/Note/Sub");
  });

  it("throws a clear error when the listing JSON is absent", async () => {
    globalThis.fetch = mock(async () => htmlResponse("<html>not a supernote</html>")) as unknown as typeof fetch;
    await expect(listFiles("192.0.2.10", "/", NO_DISCOVER)).rejects.toThrow(
      /Could not find the file listing/,
    );
  });
});

describe("downloadFile", () => {
  it("returns the raw bytes of a file", async () => {
    const data = new Uint8Array([0x6e, 0x6f, 0x74, 0x65]);
    globalThis.fetch = mock(
      async () =>
        new Response(data, { status: 200, headers: { "content-type": "application/octet-stream" } }),
    ) as unknown as typeof fetch;

    const buf = await downloadFile("192.0.2.10", "Note/meeting.note", NO_DISCOVER);
    expect(Buffer.from(buf)).toEqual(Buffer.from(data));
  });

  it("rejects when the device returns an HTML page instead of a file", async () => {
    globalThis.fetch = mock(async () => htmlResponse("<html>directory listing</html>")) as unknown as typeof fetch;
    await expect(downloadFile("192.0.2.10", "stale/path", NO_DISCOVER)).rejects.toThrow(
      /returned an HTML page/,
    );
  });
});
