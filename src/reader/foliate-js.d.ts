declare module "foliate-js/view.js" {
  export type EpubSection = {
    id?: string;
    cfi?: string;
    load: () => Promise<string>;
    unload: () => void;
    resolveHref: (href: string) => string;
  };

  export type EpubTocItem = {
    label?: string;
    href?: string;
    subitems?: EpubTocItem[];
  };

  export type EpubBook = {
    metadata?: { title?: unknown };
    sections: EpubSection[];
    toc?: EpubTocItem[];
    resolveHref: (href: string) => { index: number } | null;
    destroy?: () => void;
  };

  export function makeBook(file: File): Promise<EpubBook>;
}

declare module "foliate-js/epubcfi.js" {
  export function fromRange(range: Range): string;
  export function joinIndir(parent: string, relative: string): string;
  export function parse(cfi: string): unknown;
  export function toRange(document: Document, cfi: unknown): Range;
}

declare module "foliate-js/vendor/zip.js" {
  export class BlobReader {
    constructor(blob: Blob);
  }

  export type ZipEntry = {
    filename: string;
    directory: boolean;
    uncompressedSize: number;
    getData(
      destination: WritableStream<Uint8Array>,
      options?: Record<string, unknown>,
    ): Promise<unknown>;
  };

  export class ZipReader {
    constructor(reader: BlobReader);
    getEntries(): Promise<ZipEntry[]>;
    close(): Promise<void>;
  }

  export function configure(options: { useWebWorkers?: boolean }): void;
}
