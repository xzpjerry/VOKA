export const MAX_READER_FILE_BYTES = 100 * 1024 * 1024;

export type ReaderPosition = {
  sectionIndex: number;
  cfi?: string;
  scrollRatio: number;
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

function isReaderPosition(value: unknown): value is ReaderPosition {
  if (typeof value !== "object" || value === null) return false;
  const position = value as Partial<ReaderPosition>;
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
