import { afterEach, describe, expect, it, mock } from "bun:test";
import { downloadFile, listFiles, uploadFile } from "../src/browse.js";

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

describe("uploadFile", () => {
  it("POSTs the file as multipart form-data to the target directory", async () => {
    let captured: { url: string; method?: string; body: unknown } | undefined;
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: url.toString(), method: init?.method, body: init?.body };
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;

    await uploadFile("192.0.2.10", "/Note", "hello.txt", Buffer.from("hi"), NO_DISCOVER);

    expect(captured?.method).toBe("POST");
    expect(captured?.url).toBe("http://192.0.2.10:8089/Note");
    expect(captured?.body).toBeInstanceOf(FormData);
    const file = (captured?.body as FormData).get("file");
    expect(file).toBeInstanceOf(Blob);
  });

  it("rejects when the device responds with a non-OK status", async () => {
    globalThis.fetch = mock(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    await expect(
      uploadFile("192.0.2.10", "/", "x.txt", Buffer.from("y"), NO_DISCOVER),
    ).rejects.toThrow(/HTTP 500/);
  });
});
