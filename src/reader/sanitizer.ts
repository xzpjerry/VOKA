export const EPUB_CSP =
  "default-src 'none'; script-src 'none'; connect-src 'none'; img-src data: blob:; style-src 'unsafe-inline' blob:; font-src data: blob:; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";

const resourceElements = new Set([
  "audio",
  "embed",
  "iframe",
  "image",
  "img",
  "link",
  "object",
  "source",
  "track",
  "use",
  "video",
]);

export type InternalResourceResolver = (
  value: string,
  element: Element,
  attribute: string,
) => string | undefined;

function isRemoteUrl(value: string) {
  return /^(?:https?:)?\/\//i.test(value.trim());
}

function isBlobOrDataUrl(value: string) {
  return /^(?:blob:|data:)/i.test(value.trim());
}

function stripRemoteCss(css: string) {
  return css
    .replace(
      /@import\s+(?:url\(\s*)?["']?(?:https?:)?\/\/[^;'"\s)]+["']?\s*\)?[^;]*;?/gi,
      "",
    )
    .replace(/url\(\s*(["']?)(.*?)\1\s*\)/gi, (whole, _quote, value: string) =>
      isRemoteUrl(value) ? 'url("data:,")' : whole,
    );
}

function blockAttribute(element: Element, attribute: Attr) {
  const name = attribute.name.toLowerCase();
  element.setAttribute(`data-voka-blocked-${name.replace(":", "-")}`, attribute.value);
  element.removeAttributeNode(attribute);
}

/**
 * Sanitizes a Foliate-created chapter before it is serialized into the sandboxed
 * reader iframe. Foliate's section loader rewrites packaged resources to Blob
 * URLs first; the resolver is available for unrewritten internal references.
 */
export function sanitizeEpubDocument(
  doc: Document,
  resolveInternalResource?: InternalResourceResolver,
) {
  doc.querySelectorAll("script, base").forEach((element) => element.remove());

  for (const element of Array.from(doc.querySelectorAll("*"))) {
    const tag = element.localName.toLowerCase();
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on")) {
        element.removeAttributeNode(attribute);
        continue;
      }

      if (name === "style") {
        element.setAttribute(name, stripRemoteCss(attribute.value));
        continue;
      }

      const resourceAttribute = [
        "src",
        "srcset",
        "poster",
        "data",
        "background",
        "href",
        "xlink:href",
      ].includes(name);
      if (!resourceAttribute || (!resourceElements.has(tag) && name !== "srcset"))
        continue;

      const value = attribute.value.trim();
      if (name === "href" || name === "xlink:href") {
        if (value.startsWith("#")) continue;
      }
      if (name === "srcset") {
        const candidates = value.split(",").map((item) => item.trim().split(/\s+/, 1)[0]);
        if (candidates.some(isRemoteUrl)) {
          blockAttribute(element, attribute);
          continue;
        }
        if (candidates.every(isBlobOrDataUrl)) continue;
        blockAttribute(element, attribute);
        continue;
      }
      if (isRemoteUrl(value)) {
        blockAttribute(element, attribute);
        continue;
      }
      if (isBlobOrDataUrl(value)) continue;

      const resolved = resolveInternalResource?.(value, element, name);
      if (resolved && isBlobOrDataUrl(resolved)) element.setAttribute(name, resolved);
      else blockAttribute(element, attribute);
    }

    if (tag === "style")
      element.textContent = stripRemoteCss(element.textContent ?? "");
  }

  const head = doc.querySelector("head");
  if (!head) throw new Error("EPUB chapter has no head element");
  doc
    .querySelectorAll('meta[http-equiv="Content-Security-Policy" i]')
    .forEach((meta) => meta.remove());
  const csp = doc.createElementNS("http://www.w3.org/1999/xhtml", "meta");
  csp.setAttribute("http-equiv", "Content-Security-Policy");
  csp.setAttribute("content", EPUB_CSP);
  head.prepend(csp);
}

export { stripRemoteCss };
