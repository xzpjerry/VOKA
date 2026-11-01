import * as CFI from "foliate-js/epubcfi.js";
import { makeBook } from "foliate-js/view.js";
import * as pdfjs from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import "./reader.css";

const HIGHLIGHT_NAME = "voka-important";
const PDF_SCAN_MESSAGE = "此 PDF 没有可识别的文字层，暂不支持";
const EPUB_CSP = "default-src 'none'; script-src 'none'; connect-src 'none'; img-src data: blob:; style-src 'unsafe-inline' blob:; font-src data: blob:; media-src 'none'; object-src 'none'; frame-src 'none'";

type ResearchState = {
  inputOpened: boolean;
  kind: "epub" | "pdf" | null;
  epubLoadedSections: number[];
  epubFixtureScriptPresent: boolean;
  epubScriptRan: boolean;
  epubRemoteImagePresent: boolean;
  epubHighlightRegistered: boolean;
  epubHighlightDocumentUrl: string | null;
  epubCFI: string | null;
  pdfPage: number | null;
  pdfTextChars: number;
  pdfHighlightRegistered: boolean;
  pdfWorkerSrc: string;
  scanned: boolean;
  error: string | null;
};

declare global {
  interface Window {
    __vokaResearchState: ResearchState;
    __vokaResearchGoToSecond?: () => Promise<void>;
  }
}

const state: ResearchState = {
  inputOpened: false,
  kind: null,
  epubLoadedSections: [],
  epubFixtureScriptPresent: false,
  epubScriptRan: false,
  epubRemoteImagePresent: false,
  epubHighlightRegistered: false,
  epubHighlightDocumentUrl: null,
  epubCFI: null,
  pdfPage: null,
  pdfTextChars: 0,
  pdfHighlightRegistered: false,
  pdfWorkerSrc: "",
  scanned: false,
  error: null,
};
window.__vokaResearchState = state;
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const input = document.querySelector<HTMLInputElement>("#file-input")!;
const status = document.querySelector<HTMLElement>("#status")!;
const position = document.querySelector<HTMLElement>("#position")!;
const epubReader = document.querySelector<HTMLElement>("#epub-reader")!;
const epubFrame = document.querySelector<HTMLIFrameElement>("#epub-frame")!;
const epubChapter = document.querySelector<HTMLElement>("#epub-chapter")!;
const epubPrev = document.querySelector<HTMLButtonElement>("#epub-prev")!;
const epubNext = document.querySelector<HTMLButtonElement>("#epub-next")!;
const pdfReader = document.querySelector<HTMLElement>("#pdf-reader")!;
const pdfPage = document.querySelector<HTMLElement>("#pdf-page")!;
let activeBook: any;
let currentEpubSection = 0;

function setStatus(message: string) {
  status.textContent = message;
}

function resetState(kind: "epub" | "pdf") {
  activeBook = undefined;
  currentEpubSection = 0;
  window.__vokaResearchGoToSecond = undefined;
  epubReader.hidden = true;
  epubFrame.srcdoc = "";
  epubChapter.textContent = "";
  pdfReader.hidden = true;
  pdfPage.replaceChildren();
  position.textContent = "";
  CSS.highlights.delete(HIGHLIGHT_NAME);
  Object.assign(state, {
    inputOpened: true,
    kind,
    epubLoadedSections: [],
    epubFixtureScriptPresent: false,
    epubScriptRan: false,
    epubRemoteImagePresent: false,
    epubHighlightRegistered: false,
    epubHighlightDocumentUrl: null,
    epubCFI: null,
    pdfPage: null,
    pdfTextChars: 0,
    pdfHighlightRegistered: false,
    pdfWorkerSrc: "",
    scanned: false,
    error: null,
  });
}

function findWordRange(root: Node, word: string, doc: Document): Range | null {
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const matcher = new RegExp(`\\b${word}\\b`, "i");
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? "";
    const match = matcher.exec(text);
    if (!match || !match[0].length) continue;
    const range = doc.createRange();
    range.setStart(node, match.index);
    range.setEnd(node, match.index + match[0].length);
    return range;
  }
  return null;
}

function installHighlight(range: Range, doc: Document) {
  const childWindow = doc.defaultView as
    | (Window & {
        CSS: typeof CSS & { highlights?: { set: (key: string, value: unknown) => void } };
        Highlight: new (...ranges: Range[]) => unknown;
      })
    | null;
  const registry = childWindow?.CSS?.highlights;
  const HighlightConstructor = childWindow?.Highlight;
  if (!registry || !HighlightConstructor) return false;
  registry.set(HIGHLIGHT_NAME, new HighlightConstructor(range));
  return true;
}

function isRemoteUrl(value: string) {
  return /^(?:https?:)?\/\//i.test(value.trim());
}

function stripRemoteCss(css: string) {
  return css
    .replace(/@import\s+(?:url\()?\s*["']?https?:\/\/[^;'"\)]+["']?\)?[^;]*;/gi, "")
    .replace(/url\(\s*["']?(?:https?:)?\/\/[^)]+\)/gi, "url(\"data:,\")");
}

function sanitizeEpubDocument(doc: Document) {
  const resourceElements = new Set([
    "audio", "embed", "iframe", "image", "img", "link", "object", "script", "source", "track", "use", "video",
  ]);
  for (const element of Array.from(doc.querySelectorAll("*"))) {
    const tag = element.localName.toLowerCase();
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on")) {
        element.removeAttribute(attribute.name);
        continue;
      }
      const isResourceAttribute = ["src", "srcset", "poster", "data", "background", "href", "xlink:href"].includes(name);
      if (!isResourceAttribute || !isRemoteUrl(attribute.value)) continue;
      if (name === "href" && !resourceElements.has(tag)) continue;
      element.setAttribute(`data-voka-blocked-${name.replace(":", "-")}`, attribute.value);
      element.removeAttribute(attribute.name);
    }
    const inlineStyle = element.getAttribute("style");
    if (inlineStyle) element.setAttribute("style", stripRemoteCss(inlineStyle));
    if (tag === "style") element.textContent = stripRemoteCss(element.textContent ?? "");
  }

  const head = doc.querySelector("head");
  if (!head) throw new Error("EPUB chapter has no head element");
  const csp = doc.createElementNS("http://www.w3.org/1999/xhtml", "meta");
  csp.setAttribute("http-equiv", "Content-Security-Policy");
  csp.setAttribute("content", EPUB_CSP);
  head.prepend(csp);
}

async function displayEpubSection(index: number) {
  const section = activeBook?.sections[index];
  if (!section) throw new Error(`EPUB section ${index} does not exist`);
  const source = await section.createDocument() as Document;
  sanitizeEpubDocument(source);
  const html = `<!doctype html>${new XMLSerializer().serializeToString(source.documentElement)}`;
  await new Promise<void>((resolve, reject) => {
    epubFrame.addEventListener("load", () => resolve(), { once: true });
    epubFrame.addEventListener("error", () => reject(new Error("Unable to load EPUB chapter")), { once: true });
    epubFrame.srcdoc = html;
  });
  const doc = epubFrame.contentDocument;
  if (!doc) throw new Error("EPUB iframe document is not accessible");
  currentEpubSection = index;
  state.epubLoadedSections = [...new Set([...state.epubLoadedSections, index])];
  state.epubFixtureScriptPresent ||= !!doc.querySelector("script");
  const childWindow = epubFrame.contentWindow as
    | (Window & { __vokaResearchFixtureScriptRan?: boolean })
    | null;
  state.epubScriptRan ||= !!childWindow?.__vokaResearchFixtureScriptRan;
  state.epubRemoteImagePresent ||=
    !!doc.querySelector('img[data-voka-blocked-src="https://example.com/x.png"]');

  const range = findWordRange(doc.body, "important", doc);
  if (range) {
    state.epubHighlightRegistered = installHighlight(range, doc);
    state.epubHighlightDocumentUrl = doc.URL;
    const style = doc.createElementNS("http://www.w3.org/1999/xhtml", "style");
    style.textContent = `::highlight(${HIGHLIGHT_NAME}) { background: #ffe66d; color: #111; }`;
    doc.head?.append(style);
    state.epubCFI = CFI.joinIndir(section.cfi, CFI.fromRange(range));
  } else {
    state.epubCFI = section.cfi;
  }

  epubChapter.textContent = section.id ?? `Chapter ${index + 1}`;
  epubPrev.disabled = index === 0;
  epubNext.disabled = index === activeBook.sections.length - 1;
  position.textContent = state.epubCFI ? `EPUB CFI: ${state.epubCFI}` : "";
}

async function openEpub(file: File) {
  resetState("epub");
  epubReader.hidden = false;
  setStatus(`Opening EPUB: ${file.name}`);
  activeBook = await makeBook(file);
  if (!activeBook.sections?.length) throw new Error("EPUB has no readable spine sections");
  window.__vokaResearchGoToSecond = () => displayEpubSection(1);
  await displayEpubSection(0);
  setStatus("EPUB opened. The word “important” is highlighted when present.");
}

epubPrev.addEventListener("click", () => {
  void displayEpubSection(currentEpubSection - 1).catch(showReaderError);
});
epubNext.addEventListener("click", () => {
  void displayEpubSection(currentEpubSection + 1).catch(showReaderError);
});

async function openPdf(file: File) {
  resetState("pdf");
  pdfReader.hidden = false;
  setStatus(`Opening PDF: ${file.name}`);
  state.pdfWorkerSrc = pdfWorkerUrl;

  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    verbosity: 0,
  });
  const pdf = await loadingTask.promise;
  const page = await pdf.getPage(1);
  state.pdfPage = 1;
  const originalViewport = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: Math.min(1.25, 840 / originalViewport.width) });
  pdfPage.style.width = `${viewport.width}px`;
  pdfPage.style.height = `${viewport.height}px`;

  const canvas = document.createElement("canvas");
  const outputScale = window.devicePixelRatio || 1;
  canvas.width = Math.ceil(viewport.width * outputScale);
  canvas.height = Math.ceil(viewport.height * outputScale);
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  pdfPage.append(canvas);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D context is unavailable");
  context.scale(outputScale, outputScale);
  await page.render({ canvasContext: context, viewport }).promise;

  const textContent = await page.getTextContent();
  state.pdfTextChars = textContent.items.reduce((sum, item) =>
    "str" in item ? sum + item.str.trim().length : sum, 0);
  if (state.pdfTextChars === 0) {
    state.scanned = true;
    setStatus(PDF_SCAN_MESSAGE);
    return;
  }

  const textLayer = document.createElement("div");
  textLayer.className = "textLayer";
  textLayer.style.width = `${viewport.width}px`;
  textLayer.style.height = `${viewport.height}px`;
  pdfPage.append(textLayer);
  const layer = new pdfjs.TextLayer({
    textContentSource: textContent,
    container: textLayer,
    viewport,
  });
  await layer.render();
  const range = findWordRange(textLayer, "important", document);
  if (range) state.pdfHighlightRegistered = installHighlight(range, document);
  setStatus("PDF page 1 rendered with a selectable text layer.");
  position.textContent = `PDF page 1 · ${state.pdfTextChars} text characters`;
}

function showReaderError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  state.error = message;
  setStatus(`Reader error: ${message}`);
  console.error(error);
}

input.addEventListener("change", () => {
  const file = input.files?.[0];
  if (!file) return;
  const lower = file.name.toLowerCase();
  const task = lower.endsWith(".epub") || file.type === "application/epub+zip"
    ? openEpub(file)
    : lower.endsWith(".pdf") || file.type === "application/pdf"
      ? openPdf(file)
      : Promise.reject(new Error("Choose an EPUB or PDF file."));
  void task.catch(showReaderError);
});
