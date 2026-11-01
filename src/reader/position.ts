export const MAX_READER_FILE_BYTES = 100 * 1024 * 1024;

export type EpubReaderPosition = {
  sectionIndex: number;
  cfi?: string;
  scrollRatio: number;
};

export type PdfReaderPosition = {
  pageNumber: number;
  normalizedPageOffset: number;
};

export type ReaderPosition = EpubReaderPosition | PdfReaderPosition;

export type PdfPageGeometry = {
  pageNumber: number;
  top: number;
  height: number;
};

type StorageAreaLike = {
  get: (keys: string | string[]) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
};

export function readerPositionKey(sha256: string) {
  if (!/^[a-f\d]{64}$/i.test(sha256)) throw new Error("Invalid SHA-256 hash");
  return `reader-position:${sha256.toLowerCase()}`;
}

export function assertReaderSize(size: number, messageKey = "readerFileTooLarge") {
  if (!Number.isFinite(size) || size < 0 || size > MAX_READER_FILE_BYTES)
    throw new Error(messageKey);
}

export function isEpubReaderPosition(value: unknown): value is EpubReaderPosition {
  if (typeof value !== "object" || value === null) return false;
  const position = value as Partial<EpubReaderPosition>;
  return (
    Number.isInteger(position.sectionIndex) &&
    Number(position.sectionIndex) >= 0 &&
    typeof position.scrollRatio === "number" &&
    Number.isFinite(position.scrollRatio) &&
    position.scrollRatio >= 0 &&
    position.scrollRatio <= 1 &&
    (position.cfi === undefined ||
      (typeof position.cfi === "string" && position.cfi.length <= 4096))
  );
}

export function isPdfReaderPosition(value: unknown): value is PdfReaderPosition {
  if (typeof value !== "object" || value === null) return false;
  const position = value as Partial<PdfReaderPosition>;
  return (
    Number.isInteger(position.pageNumber) &&
    Number(position.pageNumber) >= 1 &&
    typeof position.normalizedPageOffset === "number" &&
    Number.isFinite(position.normalizedPageOffset) &&
    position.normalizedPageOffset >= 0 &&
    position.normalizedPageOffset <= 1
  );
}

function isReaderPosition(value: unknown): value is ReaderPosition {
  return isEpubReaderPosition(value) || isPdfReaderPosition(value);
}

/** Convert the reader scroll position to an offset that survives page zoom changes. */
export function pdfPositionFromScrollTop(
  scrollTop: number,
  pages: readonly PdfPageGeometry[],
): PdfReaderPosition | undefined {
  if (!Number.isFinite(scrollTop) || !pages.length) return undefined;
  const top = Math.max(0, scrollTop);
  let page = pages[0];
  for (const candidate of pages) {
    page = candidate;
    if (top < candidate.top + candidate.height) break;
  }
  const normalizedPageOffset = page.height > 0
    ? Math.min(1, Math.max(0, (top - page.top) / page.height))
    : 0;
  return { pageNumber: page.pageNumber, normalizedPageOffset };
}

/** Restore a normalized page offset using the page's current zoomed geometry. */
export function pdfScrollTopForPosition(
  position: PdfReaderPosition,
  pages: readonly PdfPageGeometry[],
): number | undefined {
  const page = pages.find((candidate) => candidate.pageNumber === position.pageNumber);
  if (!page || !Number.isFinite(page.top) || !Number.isFinite(page.height))
    return undefined;
  const normalized = Math.min(1, Math.max(0, position.normalizedPageOffset));
  return page.top + normalized * Math.max(0, page.height);
}

export async function saveReaderPosition(
  sha256: string,
  position: ReaderPosition,
  storage: StorageAreaLike = chrome.storage.local,
) {
  if (!isReaderPosition(position)) throw new Error("Invalid reader position");
  await storage.set({ [readerPositionKey(sha256)]: position });
}

export async function loadReaderPosition(
  sha256: string,
  storage: StorageAreaLike = chrome.storage.local,
): Promise<ReaderPosition | undefined> {
  const key = readerPositionKey(sha256);
  const result = await storage.get(key);
  const position = result[key];
  return isReaderPosition(position) ? position : undefined;
}

export async function hashFileBytes(file: Blob) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
