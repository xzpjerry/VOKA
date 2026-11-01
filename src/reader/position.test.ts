import { describe, expect, it } from "vitest";
import {
  assertReaderSize,
  loadReaderPosition,
  MAX_READER_FILE_BYTES,
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
});
