import { SupernoteX } from "supernote-typescript";

/** RecognitionStatuses.DONE from supernote-typescript (not re-exported from the package root). */
const RECOGNITION_DONE = "1";

/** Recognized text for a single note page. */
export interface PageText {
  /** 1-indexed page number. */
  page: number;
  /** True if on-device handwriting recognition has completed for this page. */
  recognized: boolean;
  /** Recognized text (best available: paragraphs, else raw text), trimmed. */
  text: string;
}

export interface NoteText {
  pages: PageText[];
  /** All pages' text joined with page separators. */
  combinedText: string;
  /** True if any page yielded recognized text. */
  hasText: boolean;
}

/** Parse raw `.note` bytes. Throws if the buffer isn't a recognisable Supernote file. */
export function parseNote(bytes: Buffer): SupernoteX {
  return new SupernoteX(bytes);
}

/**
 * Pull recognized handwriting/text out of a parsed note. Prefers `paragraphs`
 * (better line structure) and falls back to `text`. Pages where recognition
 * hasn't run yield empty text and `recognized: false`.
 */
export function extractText(note: SupernoteX): NoteText {
  const pages: PageText[] = note.pages.map((p, i) => ({
    page: i + 1,
    recognized: p.RECOGNSTATUS === RECOGNITION_DONE,
    text: (p.paragraphs?.trim() || p.text?.trim() || ""),
  }));
  const combinedText = pages
    .filter((p) => p.text.length > 0)
    .map((p) => `--- Page ${p.page} ---\n${p.text}`)
    .join("\n\n");
  return { pages, combinedText, hasText: combinedText.length > 0 };
}
