export type HighlightSet = {
  add(range: Range): void;
  delete(range: Range): void;
};

type HighlightWindow = Window & {
  CSS: typeof CSS & { highlights?: Map<string, unknown> };
  Highlight?: new (...ranges: Range[]) => HighlightSet;
};

/** Manage CSS Custom Highlights in the window that owns the target document. */
export function createHighlightRegistry(doc: Document) {
  const win = doc.defaultView as HighlightWindow | null;
  const highlights = win?.CSS?.highlights;
  const HighlightConstructor = win?.Highlight;

  return {
    get available() {
      return !!highlights && !!HighlightConstructor;
    },
    set(name: string, ranges: Iterable<Range> = []): HighlightSet {
      if (!highlights || !HighlightConstructor)
        throw new Error("Highlight API unavailable");
      const highlight = new HighlightConstructor(...ranges);
      highlights.set(name, highlight);
      return highlight;
    },
    clear(name: string) {
      highlights?.delete(name);
    },
  };
}
