import type { ReadingSource } from "../reading-session";
import { textStream } from "../text-stream";

export function pdfTextCharacterCount(items: readonly unknown[]) {
  return items.reduce<number>((count, item) => {
    if (typeof item !== "object" || item === null || !("str" in item))
      return count;
    const value = (item as { str?: unknown }).str;
    const text = typeof value === "string" ? value : "";
    return count + [...text].filter((char) => !/\s/u.test(char)).length;
  }, 0);
}

export function hasPdfPageText(items: readonly unknown[]) {
  return pdfTextCharacterCount(items) > 0;
}

/** Only the first three pages determine whether a PDF has any usable text at all. */
export function isPdfFileTextless(
  firstPageCharacterCounts: readonly number[],
  pageCount: number,
) {
  const sampleCount = Math.min(3, Math.max(0, pageCount));
  return sampleCount > 0 &&
    firstPageCharacterCounts.length >= sampleCount &&
    firstPageCharacterCounts.slice(0, sampleCount).every((count) => count === 0);
}

export function pdfPageNumberFromSourceId(sourceId: string) {
  const match = /^pdf-page-([1-9]\d*)$/.exec(sourceId);
  if (!match) return undefined;
  const pageNumber = Number(match[1]);
  return Number.isSafeInteger(pageNumber) ? pageNumber : undefined;
}

export type PdfStreamSession = {
  addSource(source: ReadingSource): void;
  removeSource(source: ReadingSource): void;
};

/** Registers one page's joined PDF.js text layer with the shared reading session. */
export class PdfPageStreamRegistry {
  private readonly sources = new Map<number, Extract<ReadingSource, { kind: "stream" }>>();

  constructor(private readonly session: PdfStreamSession) {}

  register(pageNumber: number, textLayer: Element) {
    if (!Number.isInteger(pageNumber) || pageNumber < 1)
      throw new RangeError("PDF page numbers must be positive integers");
    const existing = this.sources.get(pageNumber);
    if (existing) return existing;

    const stream = textStream(textLayer);
    const source: Extract<ReadingSource, { kind: "stream" }> = {
      kind: "stream",
      id: `pdf-page-${pageNumber}`,
      text: () => stream.text,
      rangeFor: stream.rangeFor,
      document: textLayer.ownerDocument,
    };
    this.sources.set(pageNumber, source);
    this.session.addSource(source);
    return source;
  }

  unregister(pageNumber: number) {
    const source = this.sources.get(pageNumber);
    if (!source) return;
    this.sources.delete(pageNumber);
    this.session.removeSource(source);
  }

  clear() {
    for (const pageNumber of [...this.sources.keys()]) this.unregister(pageNumber);
  }
}
