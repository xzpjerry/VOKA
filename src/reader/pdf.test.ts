// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import type { ReadingSource } from "../reading-session";
import {
  PdfPageStreamRegistry,
  hasPdfPageText,
  isPdfFileTextless,
  pdfPageNumberFromSourceId,
} from "./pdf";

describe("PDF text availability", () => {
  it("detects per-page text using non-whitespace characters", () => {
    expect(hasPdfPageText([{ str: " \n\t" }])).toBe(false);
    expect(hasPdfPageText([{ str: " \n" }, { str: "read" }])).toBe(true);
  });

  it("marks a file unsupported only when the first three or all shorter files are textless", () => {
    expect(isPdfFileTextless([0, 0, 0], 5)).toBe(true);
    expect(isPdfFileTextless([0, 0, 0, 12], 4)).toBe(true);
    expect(isPdfFileTextless([0, 4, 0], 3)).toBe(false);
    expect(isPdfFileTextless([0, 0], 2)).toBe(true);
    expect(isPdfFileTextless([0], 2)).toBe(false);
  });
});

describe("PDF stream source page numbers", () => {
  it("extracts a page number only from a PDF page source id", () => {
    expect(pdfPageNumberFromSourceId("pdf-page-3")).toBe(3);
    expect(pdfPageNumberFromSourceId("pdf-page-1")).toBe(1);
    expect(pdfPageNumberFromSourceId("pdf-page-0")).toBeUndefined();
    expect(pdfPageNumberFromSourceId("page-3")).toBeUndefined();
    expect(pdfPageNumberFromSourceId("pdf-page-3-extra")).toBeUndefined();
    expect(pdfPageNumberFromSourceId("pdf-page-9007199254740992")).toBeUndefined();
  });
});

describe("PDF page stream lifecycle", () => {
  it("adds a joined text stream when rendered and removes it when unrendered", () => {
    const added: ReadingSource[] = [];
    const removed: ReadingSource[] = [];
    const registry = new PdfPageStreamRegistry({
      addSource: (source) => added.push(source),
      removeSource: (source) => removed.push(source),
    });
    const page = document.createElement("div");
    page.className = "textLayer";
    const first = document.createElement("span");
    const second = document.createElement("span");
    first.textContent = "ach";
    second.textContent = "ieve";
    page.append(first, second);
    document.body.append(page);

    const source = registry.register(2, page);
    expect(registry.register(2, page)).toBe(source);
    expect(added).toEqual([source]);
    expect(source).toMatchObject({ kind: "stream", id: "pdf-page-2", document });
    if (source.kind !== "stream") throw new Error("PDF pages use stream sources");
    expect(source.text()).toBe("achieve");
    expect(source.rangeFor(1, 6).toString()).toBe("chiev");

    registry.unregister(2);
    registry.unregister(2);
    expect(removed).toEqual([source]);
    page.remove();
  });

  it("clears every remaining rendered page stream", () => {
    const removed: ReadingSource[] = [];
    const registry = new PdfPageStreamRegistry({
      addSource: () => {},
      removeSource: (source) => removed.push(source),
    });
    const first = document.createElement("div");
    const second = document.createElement("div");
    registry.register(1, first);
    registry.register(3, second);

    registry.clear();
    expect(removed.map((source) => source.kind === "stream" ? source.id : ""))
      .toEqual(["pdf-page-1", "pdf-page-3"]);
  });
});
