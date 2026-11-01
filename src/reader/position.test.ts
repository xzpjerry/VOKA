import { describe, expect, it } from "vitest";
import {
  assertReaderSize,
  loadReaderPosition,
  MAX_READER_FILE_BYTES,
  pdfPositionFromScrollTop,
  pdfScrollTopForPosition,
  readerPositionKey,
  saveReaderPosition,
} from "./position";

function createStorage() {
  const values: Record<string, unknown> = {};
  return {
    values,
    async get(keys: string | string[]) {
      const requested = typeof keys === "string" ? [keys] : keys;
      return Object.fromEntries(requested.filter((key) => key in values).map((key) => [key, values[key]]));
    },
    async set(items: Record<string, unknown>) {
      Object.assign(values, items);
    },
  };
}

describe("reader position storage", () => {
  it("keys positions by SHA-256 and restores the stored section and offset", async () => {
    const hash = "a".repeat(64);
    const storage = createStorage();
    const position = { sectionIndex: 2, cfi: "epubcfi(/6/4!/4/2)", scrollRatio: 0.42 };

    await saveReaderPosition(hash, position, storage);

    expect(Object.keys(storage.values)).toEqual([`reader-position:${hash}`]);
    expect(await loadReaderPosition(hash, storage)).toEqual(position);
    expect(readerPositionKey(hash.toUpperCase())).toBe(`reader-position:${hash}`);
  });

  it("enforces the compressed and expanded size limit", () => {
    expect(() => assertReaderSize(MAX_READER_FILE_BYTES)).not.toThrow();
    expect(() => assertReaderSize(MAX_READER_FILE_BYTES + 1)).toThrow("readerFileTooLarge");
    expect(() => assertReaderSize(MAX_READER_FILE_BYTES + 1, "readerExpandedTooLarge"))
      .toThrow("readerExpandedTooLarge");
  });

  it("normalizes page offsets and restores them at a different zoom", () => {
    const originalPages = [
      { pageNumber: 1, top: 0, height: 1000 },
      { pageNumber: 2, top: 1040, height: 1000 },
      { pageNumber: 3, top: 2080, height: 1000 },
    ];
    const position = pdfPositionFromScrollTop(1540, originalPages);

    expect(position).toEqual({ pageNumber: 2, normalizedPageOffset: 0.5 });
    expect(
      pdfScrollTopForPosition(position!, [
        { pageNumber: 1, top: 0, height: 1600 },
        { pageNumber: 2, top: 1640, height: 1600 },
        { pageNumber: 3, top: 3280, height: 1600 },
      ]),
    ).toBe(2440);
  });

  it("clamps offsets and returns no position when there are no page boxes", () => {
    expect(pdfPositionFromScrollTop(-20, [{ pageNumber: 1, top: 0, height: 500 }]))
      .toEqual({ pageNumber: 1, normalizedPageOffset: 0 });
    expect(pdfPositionFromScrollTop(200, [])).toBeUndefined();
    expect(pdfScrollTopForPosition({ pageNumber: 8, normalizedPageOffset: 0.5 }, []))
      .toBeUndefined();
  });
});
