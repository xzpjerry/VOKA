// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { Window } from "happy-dom";
import { createHighlightRegistry } from "./highlight-registry";
import { extract } from "./reading";

function override(target: object, name: string, value: unknown) {
  const original = Object.getOwnPropertyDescriptor(target, name);
  Object.defineProperty(target, name, {
    configurable: true,
    writable: true,
    value,
  });
  return () => {
    if (original) Object.defineProperty(target, name, original);
    else Reflect.deleteProperty(target, name);
  };
}

it("extracts and registers highlights in the iframe document's window", () => {
  const parentWindow = new Window({
    settings: { enableIframePageLoading: true },
  });
  const parentDoc = parentWindow.document as unknown as Document;
  const iframe = parentDoc.createElement("iframe");
  parentDoc.body.append(iframe);
  const iframeDoc = iframe.contentDocument! as unknown as Document;
  iframeDoc.open();
  iframeDoc.write("<!doctype html><html><body><p>important</p></body></html>");
  iframeDoc.close();
  const iframeWindow = iframeDoc.defaultView!;
  const parentHighlights = new Map<string, unknown>();
  const iframeHighlights = new Map<string, unknown>();

  class IframeHighlight {
    readonly ranges: Set<Range>;
    constructor(...ranges: Range[]) {
      this.ranges = new Set(ranges);
    }
    add(range: Range) {
      this.ranges.add(range);
    }
    delete(range: Range) {
      this.ranges.delete(range);
    }
  }

  const parentHighlightConstructor = vi.fn();
  const restoreParentCSS = override(parentWindow, "CSS", {
    highlights: parentHighlights,
  });
  const restoreParentHighlight = override(
    parentWindow,
    "Highlight",
    parentHighlightConstructor,
  );
  const restoreIframeCSS = override(iframeWindow, "CSS", {
    highlights: iframeHighlights,
  });
  const restoreIframeHighlight = override(
    iframeWindow,
    "Highlight",
    IframeHighlight,
  );

  try {
    const token = extract(iframeDoc.body)[0];
    expect(token.range.startContainer.ownerDocument).toBe(iframeDoc);

    const registry = createHighlightRegistry(iframeDoc);
    expect(registry.available).toBe(true);
    const highlight = registry.set("voka-test", [token.range]);

    expect(highlight).toBeInstanceOf(IframeHighlight);
    expect(iframeHighlights.get("voka-test")).toBe(highlight);
    expect(parentHighlights.size).toBe(0);
    expect(parentHighlightConstructor).not.toHaveBeenCalled();

    registry.clear("voka-test");
    expect(iframeHighlights.has("voka-test")).toBe(false);
  } finally {
    restoreIframeHighlight();
    restoreIframeCSS();
    restoreParentHighlight();
    restoreParentCSS();
    iframe.remove();
    parentWindow.close();
  }
});
