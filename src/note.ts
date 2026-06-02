import { SupernoteX, toImage } from "supernote-typescript";

/** RecognitionStatuses.DONE from supernote-typescript (not re-exported from the package root). */
const RECOGNITION_DONE = "1";

/** Default ceiling on how many pages to render at once, to keep tool payloads sane. */
export const DEFAULT_MAX_RENDER_PAGES = 20;

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

/** Parse raw `.note` bytes. Throws a clear error if the buffer isn't a Supernote note. */
export function parseNote(bytes: Buffer): SupernoteX {
  try {
    return new SupernoteX(bytes);
  } catch (err) {
    throw new Error(
      "This file isn't a readable Supernote note (.note) — it may be a different format (e.g. a PDF " +
        `or image), an unsupported firmware version, or corrupted: ${(err as Error).message}`,
      { cause: err },
    );
  }
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

/** A rendered note page as a base64 PNG. */
export interface RenderedPage {
  /** 1-indexed page number. */
  page: number;
  /** Base64-encoded PNG. */
  base64: string;
  mimeType: string;
}

/**
 * Resolve which 1-indexed pages to render: the `requested` set (in order) or all
 * pages, dropping out-of-range numbers and capping at `max`. Pure — no rendering.
 */
export function selectPages(
  total: number,
  requested: number[] | undefined,
  max = DEFAULT_MAX_RENDER_PAGES,
): { pages: number[]; truncated: boolean } {
  const all = Array.from({ length: total }, (_, i) => i + 1);
  const source = requested && requested.length > 0 ? requested : all;
  const seen = new Set<number>();
  const chosen: number[] = [];
  for (const n of source) {
    if (Number.isInteger(n) && n >= 1 && n <= total && !seen.has(n)) {
      seen.add(n);
      chosen.push(n);
    }
  }
  const truncated = chosen.length > max;
  return { pages: truncated ? chosen.slice(0, max) : chosen, truncated };
}

/** Renders selected pages of a note to `image-js` images (defaults to the real `toImage`). */
export type PageRenderer = (
  note: SupernoteX,
  pageNumbers: number[],
) => Promise<{ toBase64: () => string | Promise<string> }[]>;

/** Render the given 1-indexed pages of a note to base64 PNGs. */
export async function renderPages(
  note: SupernoteX,
  pageNumbers: number[],
  render: PageRenderer = toImage,
): Promise<RenderedPage[]> {
  const images = await render(note, pageNumbers);
  return Promise.all(
    images.map(async (image, idx) => {
      const raw = await image.toBase64();
      return {
        page: pageNumbers[idx] ?? idx + 1,
        base64: raw.replace(/^data:[^;]+;base64,/, ""),
        mimeType: "image/png",
      };
    }),
  );
}
