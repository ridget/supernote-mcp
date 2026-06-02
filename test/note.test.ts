import { describe, expect, it } from "bun:test";
import type { SupernoteX } from "supernote-typescript";
import { extractText } from "../src/note.js";

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
