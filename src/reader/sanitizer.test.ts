import { describe, expect, it } from "vitest";
import { Window } from "happy-dom";
import { EPUB_CSP, sanitizeEpubDocument } from "./sanitizer";

describe("EPUB chapter sanitizer", () => {
  it("removes scripts and event handlers, blocks remote assets, and rewrites packaged assets", () => {
    const testWindow = new Window();
    const doc = new testWindow.DOMParser().parseFromString(
      `<!doctype html><html><head><style>
        @import url("https://example.com/remote.css");
        .remote { background-image: url(//example.com/remote.png); }
        .local { background-image: url("blob:chrome-extension://test/image.png"); }
      </style></head><body>
        <script>window.fixtureRan = true</script>
        <p onclick="window.fixtureRan = true">A helpful idea.</p>
        <img id="internal" src="images/inside.png" onerror="window.fixtureRan = true">
        <img id="external" src="https://example.com/x.png">
      </body></html>`,
      "text/html",
    );

    sanitizeEpubDocument(doc as unknown as Document, (value) =>
      value === "images/inside.png" ? "blob:chrome-extension://test/inside.png" : undefined,
    );

    expect(doc.querySelector("script")).toBeNull();
    expect(doc.querySelector("p")?.hasAttribute("onclick")).toBe(false);
    expect(doc.querySelector("img[onerror]")).toBeNull();
    expect(doc.querySelector("#internal")?.getAttribute("src")).toMatch(/^blob:/);
    expect(doc.querySelector("#external")?.hasAttribute("src")).toBe(false);
    expect(doc.querySelector("#external")?.getAttribute("data-voka-blocked-src")).toBe(
      "https://example.com/x.png",
    );
    const css = doc.querySelector("style")?.textContent ?? "";
    expect(css).not.toContain("@import");
    expect(css).not.toContain("https://example.com");
    expect(css).toContain('url("data:,")');
    expect(css).toContain("blob:chrome-extension://test/image.png");
    expect(doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content")).toBe(EPUB_CSP);
    testWindow.happyDOM.abort();
  });
});
