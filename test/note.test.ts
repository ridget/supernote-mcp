import { describe, expect, it } from "bun:test";
import type { SupernoteX } from "supernote-typescript";
import { extractText, parseNote, renderPages, selectPages } from "../src/note.js";

// extractText only reads `.pages`, so a plain object stands in for a parsed note —
// no need to mock the shared supernote-typescript module (which would clobber the
// fetchMirrorFrame export other test files rely on).
function noteWith(
  pages: { RECOGNSTATUS: string; text?: string; paragraphs?: string }[],
): SupernoteX {
  return { pages } as unknown as SupernoteX;
}

const DONE = "1";
const NONE = "0";

describe("extractText", () => {
  it("returns recognized text per page, preferring paragraphs over raw text", () => {
    const result = extractText(
      noteWith([
        { RECOGNSTATUS: DONE, paragraphs: "Para one", text: "raw one" },
        { RECOGNSTATUS: DONE, text: "raw two" },
      ]),
    );

    expect(result.hasText).toBe(true);
    expect(result.pages).toHaveLength(2);
    expect(result.pages[0]).toMatchObject({ page: 1, recognized: true, text: "Para one" });
    expect(result.pages[1]).toMatchObject({ page: 2, recognized: true, text: "raw two" });
    expect(result.combinedText).toBe("--- Page 1 ---\nPara one\n\n--- Page 2 ---\nraw two");
  });

  it("reports no text when recognition has not run", () => {
    const result = extractText(
      noteWith([
        { RECOGNSTATUS: NONE, text: "" },
        { RECOGNSTATUS: NONE },
      ]),
    );

    expect(result.hasText).toBe(false);
    expect(result.combinedText).toBe("");
    expect(result.pages.every((p) => !p.recognized)).toBe(true);
  });

  it("skips blank pages but keeps numbering", () => {
    const result = extractText(
      noteWith([
        { RECOGNSTATUS: DONE, text: "first" },
        { RECOGNSTATUS: DONE, text: "" },
        { RECOGNSTATUS: DONE, text: "third" },
      ]),
    );

    expect(result.combinedText).toBe("--- Page 1 ---\nfirst\n\n--- Page 3 ---\nthird");
    expect(result.pages).toHaveLength(3);
  });
});

describe("parseNote", () => {
  it("throws a clear, actionable error when the bytes aren't a Supernote note", () => {
    expect(() => parseNote(Buffer.from("this is not a .note file"))).toThrow(
      /isn't a readable Supernote note/,
    );
  });
});

describe("renderPages", () => {
  it("maps each rendered image to its 1-indexed page and strips the data-url prefix", async () => {
    const render = async (_note: SupernoteX, pages: number[]) =>
      pages.map(() => ({ toBase64: async () => "data:image/png;base64,UE5H" }));

    const rendered = await renderPages({} as SupernoteX, [3, 5], render);

    expect(rendered).toEqual([
      { page: 3, base64: "UE5H", mimeType: "image/png" },
      { page: 5, base64: "UE5H", mimeType: "image/png" },
    ]);
  });
});

describe("selectPages", () => {
  it("defaults to all pages when none are requested", () => {
    expect(selectPages(3, undefined)).toEqual({ pages: [1, 2, 3], truncated: false });
  });

  it("keeps the requested order and drops out-of-range numbers", () => {
    expect(selectPages(3, [3, 1, 9, 0])).toEqual({ pages: [3, 1], truncated: false });
  });

  it("caps at the max and flags truncation", () => {
    expect(selectPages(10, undefined, 4)).toEqual({ pages: [1, 2, 3, 4], truncated: true });
  });

  it("dedupes repeated page numbers, keeping first-seen order", () => {
    expect(selectPages(3, [1, 1, 2, 2, 1])).toEqual({ pages: [1, 2], truncated: false });
  });
});
