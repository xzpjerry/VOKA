import * as CFI from "foliate-js/epubcfi.js";
import { makeBook, type EpubBook, type EpubSection, type EpubTocItem } from "foliate-js/view.js";
import { BlobReader, configure, ZipReader } from "foliate-js/vendor/zip.js";
import * as pdfjs from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import { createReadingSession, READING_HIGHLIGHT_CSS, type ReadingSource } from "../reading-session";
import { t } from "../shared";
import { sanitizeEpubDocument } from "./sanitizer";
import {
  PdfPageStreamRegistry,
  hasPdfPageText,
  isPdfFileTextless,
  pdfPageNumberFromSourceId,
  pdfTextCharacterCount,
} from "./pdf";
import {
  assertReaderSize,
  hashFileBytes,
  isEpubReaderPosition,
  isPdfReaderPosition,
  loadReaderPosition,
  MAX_READER_FILE_BYTES,
  pdfPositionFromScrollTop,
  pdfScrollTopForPosition,
  readerPositionKey,
  saveReaderPosition,
  type PdfPageGeometry,
  type PdfReaderPosition,
  type EpubReaderPosition,
  type ReaderPosition,
} from "./position";
import "./reader.css";

type PdfLoadingTask = ReturnType<typeof pdfjs.getDocument>;
type PdfDocument = Awaited<PdfLoadingTask["promise"]>;
type PdfPage = Awaited<ReturnType<PdfDocument["getPage"]>>;
type PdfTextContent = Awaited<ReturnType<PdfPage["getTextContent"]>>;
type PdfRenderTask = ReturnType<PdfPage["render"]>;

const input = document.querySelector<HTMLInputElement>("#file-input")!;
const openButton = document.querySelector<HTMLButtonElement>("#open-file")!;
const title = document.querySelector<HTMLHeadingElement>("#book-title")!;
const tocLabel = document.querySelector<HTMLLabelElement>(".toc-label")!;
const toc = document.querySelector<HTMLSelectElement>("#toc")!;
const previous = document.querySelector<HTMLButtonElement>("#previous-chapter")!;
const next = document.querySelector<HTMLButtonElement>("#next-chapter")!;
const status = document.querySelector<HTMLElement>("#reader-status")!;
const frame = document.querySelector<HTMLIFrameElement>("#epub-frame")!;
const pdfPlaceholder = document.querySelector<HTMLElement>("#pdf-placeholder")!;
const pdfReader = document.querySelector<HTMLElement>("#pdf-reader")!;
const pdfPagesElement = document.querySelector<HTMLElement>("#pdf-pages")!;
const pdfControls = document.querySelector<HTMLElement>("#pdf-controls")!;
const pdfPageNumberLabel = document.querySelector<HTMLElement>("#pdf-page-number-label")!;
const pdfPageNumber = document.querySelector<HTMLInputElement>("#pdf-page-number")!;
const pdfPageTotal = document.querySelector<HTMLElement>("#pdf-page-total")!;
const pdfPreviousPage = document.querySelector<HTMLButtonElement>("#pdf-previous-page")!;
const pdfNextPage = document.querySelector<HTMLButtonElement>("#pdf-next-page")!;
const pdfZoom100 = document.querySelector<HTMLButtonElement>("#pdf-zoom-100")!;
const pdfZoomFit = document.querySelector<HTMLButtonElement>("#pdf-zoom-fit")!;

type TocEntry = { index: number; label: string };
type PdfPageLayout = {
  pageNumber: number;
  page: PdfPage;
  baseWidth: number;
  element: HTMLDivElement;
};
type RenderedPdfPage = {
  layout: PdfPageLayout;
  promise: Promise<void>;
  renderTask?: PdfRenderTask;
  textLayer?: HTMLDivElement;
};
let book: EpubBook | undefined;
let pdfDocument: PdfDocument | undefined;
let pdfLoadingTask: PdfLoadingTask | undefined;
let pdfPageLayouts: PdfPageLayout[] = [];
let renderedPdfPages = new Map<number, RenderedPdfPage>();
let pdfTextContentCache = new Map<number, PdfTextContent>();
let pdfStreams: PdfPageStreamRegistry;
let bookTitle = "";
let chapterTitle = "";
let fileHash = "";
let currentIndex = -1;
let currentSection: EpubSection | undefined;
let currentSource: ReadingSource | undefined;
let tocEntries: TocEntry[] = [];
let restorePosition: ReaderPosition | undefined;
let scrollTimer: number | undefined;
let scrollView: Window | null = null;
let scrollHandler: (() => void) | undefined;
let pdfScrollTimer: number | undefined;
let currentPdfPage = 1;
let pdfScale = 1;
let pdfZoomMode: "fit" | "100" = "fit";

document.title = t("readerPageTitle");
document.documentElement.lang = chrome.i18n.getUILanguage().startsWith("zh") ? "zh-CN" : "en";
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
openButton.textContent = t("readerOpenFile");
title.textContent = t("readerNoBook");
tocLabel.textContent = t("readerContents");
toc.setAttribute("aria-label", t("readerContents"));
previous.textContent = t("readerPreviousChapter");
next.textContent = t("readerNextChapter");
pdfPageNumberLabel.textContent = t("readerPdfPageNumberLabel");
pdfPageNumber.setAttribute("aria-label", t("readerPdfPageInput"));
pdfReader.setAttribute("aria-label", t("readerPdfReaderLabel"));
pdfPreviousPage.textContent = t("readerPreviousPage");
pdfNextPage.textContent = t("readerNextPage");
pdfZoom100.textContent = t("readerPdfZoom100");
pdfZoomFit.textContent = t("readerPdfFitWidth");
frame.title = t("readerPageTitle");
status.textContent = t("readerChooseFile");

const session = createReadingSession({
  uiDocument: document,
  sources: [],
  sourceLabelForToken: (_token, _storeFullUrl, source) => {
    const pageNumber =
      source?.kind === "stream"
        ? pdfPageNumberFromSourceId(source.id)
        : undefined;
    return {
      site: bookTitle,
      title: pdfDocument
        ? pageLabel(pageNumber ?? currentPdfPage)
        : chapterTitle,
    };
  },
});
void session.start();
pdfStreams = new PdfPageStreamRegistry(session);

function setStatus(key: string) {
  status.textContent = t(key);
}

function setControls(enabled: boolean) {
  toc.disabled = !enabled || tocEntries.length === 0;
  previous.disabled = !enabled || currentIndex <= 0;
  next.disabled = !enabled || !book || currentIndex >= book.sections.length - 1;
}

function showEpubControls() {
  tocLabel.hidden = false;
  toc.hidden = false;
  previous.hidden = false;
  next.hidden = false;
  pdfControls.hidden = true;
}

function pageLabel(pageNumber: number) {
  return t("readerPdfPageLabel").replace("{number}", String(pageNumber));
}

function pdfGeometries(): PdfPageGeometry[] {
  return pdfPageLayouts.map(({ pageNumber, element }) => ({
    pageNumber,
    top: element.offsetTop,
    height: element.offsetHeight,
  }));
}

function updatePdfPageControls(pageNumber = currentPdfPage) {
  const pageCount = pdfPageLayouts.length;
  currentPdfPage = Math.min(pageCount, Math.max(1, pageNumber));
  pdfPageNumber.value = String(currentPdfPage);
  pdfPageTotal.textContent = String(pageCount);
  pdfPageNumber.max = String(pageCount);
  pdfPageNumber.disabled = pageCount <= 1;
  pdfPreviousPage.disabled = currentPdfPage <= 1;
  pdfNextPage.disabled = currentPdfPage >= pageCount;
  pdfPageNumber.setAttribute("aria-label", t("readerPdfPageInput"));
  pdfPageNumberLabel.textContent = t("readerPdfPageNumberLabel");
  pdfZoom100.setAttribute("aria-pressed", String(pdfZoomMode === "100"));
  pdfZoomFit.setAttribute("aria-pressed", String(pdfZoomMode === "fit"));
}

function showPdfControls(enabled: boolean) {
  tocLabel.hidden = true;
  toc.hidden = true;
  previous.hidden = true;
  next.hidden = true;
  pdfControls.hidden = !enabled;
  pdfPreviousPage.disabled = !enabled || currentPdfPage <= 1;
  pdfNextPage.disabled = !enabled || currentPdfPage >= pdfPageLayouts.length;
  pdfPageNumber.disabled = !enabled || pdfPageLayouts.length <= 1;
}

function isEpub(file: File) {
  return file.name.toLowerCase().endsWith(".epub") || file.type === "application/epub+zip";
}

function isPdf(file: File) {
  return file.name.toLowerCase().endsWith(".pdf") || file.type === "application/pdf";
}

async function assertArchiveWithinLimits(file: File) {
  assertReaderSize(file.size);
  configure({ useWebWorkers: false });
  const reader = new ZipReader(new BlobReader(file));
  try {
    const entries = await reader.getEntries();
    const declaredSize = entries
      .filter((entry) => !entry.directory)
      .reduce((sum, entry) => sum + entry.uncompressedSize, 0);
    assertReaderSize(declaredSize, "readerExpandedTooLarge");

    let actualSize = 0;
    for (const entry of entries) {
      if (entry.directory) continue;
      await entry.getData(
        new WritableStream<Uint8Array>({
          write(chunk) {
            actualSize += chunk.byteLength;
            if (actualSize > MAX_READER_FILE_BYTES)
              throw new Error("readerExpandedTooLarge");
          },
        }),
      );
    }
  } finally {
    await reader.close();
  }
}

function flattenToc(items: EpubTocItem[] = [], result: TocEntry[] = []) {
  for (const item of items) {
    const destination = item.href ? book?.resolveHref(item.href)?.index : undefined;
    if (destination !== undefined && destination >= 0 && destination < (book?.sections.length ?? 0)) {
      result.push({ index: destination, label: item.label?.trim() || "" });
    }
    if (item.subitems?.length) flattenToc(item.subitems, result);
  }
  return result;
}

function sectionTitle(index: number) {
  return tocEntries.find((item) => item.index === index)?.label ||
    book?.sections[index]?.id?.split("/").pop() ||
    t("readerChapter").replace("{number}", String(index + 1));
}

function refreshToc(index: number) {
  if (!tocEntries.some((item) => item.index === index)) {
    tocEntries = [
      ...tocEntries,
      { index, label: sectionTitle(index) },
    ];
  }
  toc.replaceChildren();
  for (const entry of tocEntries) {
    const option = document.createElement("option");
    option.value = String(entry.index);
    option.textContent = entry.label || t("readerChapter").replace("{number}", String(entry.index + 1));
    toc.append(option);
  }
  toc.value = String(index);
  toc.disabled = tocEntries.length === 0;
}

function contentScrollTop(doc: Document) {
  return doc.scrollingElement?.scrollTop ?? doc.documentElement.scrollTop ?? 0;
}

function contentScrollRange(doc: Document) {
  const scrolling = doc.scrollingElement ?? doc.documentElement;
  return Math.max(0, scrolling.scrollHeight - scrolling.clientHeight);
}

function visibleRangeCfi(doc: Document, section: EpubSection) {
  if (!section.cfi || !doc.body) return undefined;
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.trim()) continue;
    const range = doc.createRange();
    range.setStart(node, 0);
    range.setEnd(node, Math.min(node.textContent.length, 1));
    const rect = range.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > (doc.defaultView?.innerHeight ?? 0)) continue;
    try {
      return CFI.joinIndir(section.cfi, CFI.fromRange(range));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function saveCurrentPosition() {
  if (!fileHash || currentIndex < 0 || !currentSection || !frame.contentDocument) return;
  const doc = frame.contentDocument;
  const maxScroll = contentScrollRange(doc);
  const position: EpubReaderPosition = {
    sectionIndex: currentIndex,
    scrollRatio: maxScroll ? Math.min(1, Math.max(0, contentScrollTop(doc) / maxScroll)) : 0,
  };
  const cfi = visibleRangeCfi(doc, currentSection);
  if (cfi) position.cfi = cfi;
  await saveReaderPosition(fileHash, position);
}

function detachScrollListener() {
  if (scrollTimer !== undefined) {
    window.clearTimeout(scrollTimer);
    scrollTimer = undefined;
  }
  if (scrollView && scrollHandler) scrollView.removeEventListener("scroll", scrollHandler);
  scrollView = null;
  scrollHandler = undefined;
}

function attachScrollListener(doc: Document) {
  detachScrollListener();
  scrollView = doc.defaultView;
  if (!scrollView) return;
  scrollHandler = () => {
    if (scrollTimer !== undefined) return;
    scrollTimer = window.setTimeout(() => {
      scrollTimer = undefined;
      void saveCurrentPosition();
    }, 1000);
  };
  scrollView.addEventListener("scroll", scrollHandler, { passive: true });
}

function restoreCfi(doc: Document, cfi: string) {
  try {
    const range = CFI.toRange(doc, CFI.parse(cfi));
    const container = range.startContainer;
    const target = container.nodeType === Node.ELEMENT_NODE
      ? container as Element
      : container.parentElement;
    target?.scrollIntoView({ block: "start" });
    return true;
  } catch {
    return false;
  }
}

async function restoreScroll(doc: Document, position: EpubReaderPosition) {
  if (doc.fonts) await doc.fonts.ready.catch(() => {});
  await new Promise<void>((resolve) => {
    const view = doc.defaultView;
    if (!view) return resolve();
    view.requestAnimationFrame(() => view.requestAnimationFrame(() => resolve()));
  });
  const restoredByCfi = !!position.cfi && restoreCfi(doc, position.cfi);
  await new Promise<void>((resolve) => doc.defaultView?.requestAnimationFrame(() => resolve()) ?? resolve());
  if (restoredByCfi && (position.scrollRatio === 0 || contentScrollTop(doc) > 0)) return;
  const maxScroll = contentScrollRange(doc);
  doc.defaultView?.scrollTo(0, Math.round(maxScroll * position.scrollRatio));
}

async function writeChapter(index: number, position?: EpubReaderPosition) {
  if (!book || index < 0 || index >= book.sections.length) return;
  await saveCurrentPosition();
  detachScrollListener();
  if (currentSource) {
    session.removeSource(currentSource);
    currentSource = undefined;
  }
  if (currentSection && currentSection !== book.sections[index]) currentSection.unload();

  const section = book.sections[index];
  const sectionUrl = await section.load();
  const response = await fetch(sectionUrl);
  if (!response.ok) throw new Error("Unable to read EPUB chapter");
  const chapterDoc = new DOMParser().parseFromString(await response.text(), "text/html");
  sanitizeEpubDocument(chapterDoc);
  const highlightStyle = chapterDoc.createElement("style");
  highlightStyle.textContent = READING_HIGHLIGHT_CSS;
  chapterDoc.head?.append(highlightStyle);

  const html = `<!doctype html>${new XMLSerializer().serializeToString(chapterDoc.documentElement)}`;
  await new Promise<void>((resolve, reject) => {
    const onLoad = () => resolve();
    const onError = () => reject(new Error("Unable to load EPUB chapter"));
    frame.addEventListener("load", onLoad, { once: true });
    frame.addEventListener("error", onError, { once: true });
    frame.srcdoc = html;
  });
  const chapterFrameDoc = frame.contentDocument;
  if (!chapterFrameDoc?.body) throw new Error("EPUB chapter did not load");

  currentSection = section;
  currentIndex = index;
  chapterTitle = sectionTitle(index);
  title.textContent = bookTitle;
  frame.hidden = false;
  pdfReader.hidden = true;
  pdfPlaceholder.hidden = true;
  showEpubControls();

  if (position) await restoreScroll(chapterFrameDoc, position);
  refreshToc(index);
  previous.disabled = index === 0;
  next.disabled = index === book.sections.length - 1;
  currentSource = { kind: "dom", root: chapterFrameDoc.body };
  session.addSource(currentSource);
  attachScrollListener(chapterFrameDoc);
  setControls(true);
}

function setPdfPageSize(layout: PdfPageLayout) {
  const viewport = layout.page.getViewport({ scale: pdfScale });
  layout.element.style.width = `${viewport.width}px`;
  layout.element.style.height = `${viewport.height}px`;
  layout.element.setAttribute("aria-label", pageLabel(layout.pageNumber));
}

function relayoutPdfPages() {
  for (const layout of pdfPageLayouts) setPdfPageSize(layout);
}

function unrenderPdfPage(pageNumber: number) {
  const rendered = renderedPdfPages.get(pageNumber);
  if (!rendered) return;
  renderedPdfPages.delete(pageNumber);
  pdfStreams.unregister(pageNumber);
  try {
    rendered.renderTask?.cancel();
  } catch {
    // The render task may already have finished.
  }
  rendered.layout.element.replaceChildren();
}

async function renderPdfPage(layout: PdfPageLayout) {
  const existing = renderedPdfPages.get(layout.pageNumber);
  if (existing) return existing.promise;

  const rendered: RenderedPdfPage = {
    layout,
    promise: Promise.resolve(),
  };
  renderedPdfPages.set(layout.pageNumber, rendered);
  rendered.promise = (async () => {
    const viewport = layout.page.getViewport({ scale: pdfScale });
    setPdfPageSize(layout);
    const canvas = document.createElement("canvas");
    const outputScale = window.devicePixelRatio || 1;
    canvas.width = Math.ceil(viewport.width * outputScale);
    canvas.height = Math.ceil(viewport.height * outputScale);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    layout.element.replaceChildren(canvas);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("PDF canvas is unavailable");
    rendered.renderTask = layout.page.render({
      canvas,
      canvasContext: context,
      viewport,
      transform: outputScale === 1
        ? undefined
        : [outputScale, 0, 0, outputScale, 0, 0],
    });
    await rendered.renderTask.promise;
    if (renderedPdfPages.get(layout.pageNumber) !== rendered) return;

    const textContent = pdfTextContentCache.get(layout.pageNumber) ??
      await layout.page.getTextContent();
    if (renderedPdfPages.get(layout.pageNumber) !== rendered) return;
    if (!hasPdfPageText(textContent.items)) {
      const message = document.createElement("div");
      message.className = "pdf-page-message";
      message.setAttribute("role", "status");
      message.textContent = t("readerPdfPageNoText");
      layout.element.append(message);
      pdfTextContentCache.delete(layout.pageNumber);
      return;
    }

    const textLayer = document.createElement("div");
    textLayer.className = "pdf-text-layer textLayer";
    textLayer.style.width = `${viewport.width}px`;
    textLayer.style.height = `${viewport.height}px`;
    layout.element.append(textLayer);
    rendered.textLayer = textLayer;
    const layer = new pdfjs.TextLayer({
      textContentSource: textContent,
      container: textLayer,
      viewport,
    });
    await layer.render();
    if (renderedPdfPages.get(layout.pageNumber) !== rendered) return;
    pdfStreams.register(layout.pageNumber, textLayer);
    pdfTextContentCache.delete(layout.pageNumber);
  })().catch((error: unknown) => {
    if (renderedPdfPages.get(layout.pageNumber) !== rendered) return;
    unrenderPdfPage(layout.pageNumber);
    throw error;
  });
  return rendered.promise;
}

async function updateVisiblePdfPages() {
  if (!pdfDocument || !pdfPageLayouts.length) return;
  const first = Math.max(1, currentPdfPage - 1);
  const last = Math.min(pdfPageLayouts.length, currentPdfPage + 1);
  const wanted = new Set<number>();
  for (let pageNumber = first; pageNumber <= last; pageNumber++)
    wanted.add(pageNumber);
  for (const pageNumber of renderedPdfPages.keys())
    if (!wanted.has(pageNumber)) unrenderPdfPage(pageNumber);
  await Promise.all(
    [...wanted].map((pageNumber) => renderPdfPage(pdfPageLayouts[pageNumber - 1])),
  );
}

async function saveCurrentPdfPosition() {
  if (!fileHash || !pdfDocument || !pdfPageLayouts.length) return;
  const position = pdfPositionFromScrollTop(pdfReader.scrollTop, pdfGeometries());
  if (position) await saveReaderPosition(fileHash, position);
}

function handlePdfScroll() {
  if (!pdfDocument || !pdfPageLayouts.length) return;
  const position = pdfPositionFromScrollTop(pdfReader.scrollTop, pdfGeometries());
  if (!position) return;
  if (position.pageNumber !== currentPdfPage) {
    updatePdfPageControls(position.pageNumber);
    void updateVisiblePdfPages().catch(() => setStatus("readerOpenFailed"));
  }
  if (pdfScrollTimer === undefined) {
    pdfScrollTimer = window.setTimeout(() => {
      pdfScrollTimer = undefined;
      void saveCurrentPdfPosition();
    }, 1000);
  }
}

function goToPdfPage(pageNumber: number, normalizedPageOffset = 0) {
  if (!pdfPageLayouts.length || !Number.isFinite(pageNumber)) return;
  const target = Math.min(pdfPageLayouts.length, Math.max(1, Math.round(pageNumber)));
  updatePdfPageControls(target);
  const scrollTop = pdfScrollTopForPosition(
    { pageNumber: target, normalizedPageOffset },
    pdfGeometries(),
  );
  if (scrollTop !== undefined) pdfReader.scrollTop = scrollTop;
  handlePdfScroll();
  void updateVisiblePdfPages().catch(() => setStatus("readerOpenFailed"));
}

function fitPdfScale() {
  if (!pdfPageLayouts.length) return 1;
  const widestPage = Math.max(...pdfPageLayouts.map((page) => page.baseWidth));
  const availableWidth = Math.max(1, pdfReader.clientWidth - 24);
  return availableWidth / widestPage;
}

async function changePdfZoom(mode: "fit" | "100") {
  if (!pdfDocument) return;
  const position = pdfPositionFromScrollTop(pdfReader.scrollTop, pdfGeometries()) ?? {
    pageNumber: currentPdfPage,
    normalizedPageOffset: 0,
  };
  pdfZoomMode = mode;
  pdfScale = mode === "100" ? 1 : fitPdfScale();
  for (const pageNumber of renderedPdfPages.keys()) unrenderPdfPage(pageNumber);
  relayoutPdfPages();
  updatePdfPageControls(position.pageNumber);
  const scrollTop = pdfScrollTopForPosition(position, pdfGeometries());
  if (scrollTop !== undefined) pdfReader.scrollTop = scrollTop;
  handlePdfScroll();
  await updateVisiblePdfPages();
}

async function waitForPdfLayout() {
  await new Promise<void>((resolve) =>
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())),
  );
}

async function disposeBook() {
  await saveCurrentPosition();
  await saveCurrentPdfPosition();
  detachScrollListener();
  if (pdfScrollTimer !== undefined) {
    window.clearTimeout(pdfScrollTimer);
    pdfScrollTimer = undefined;
  }
  if (currentSource) session.removeSource(currentSource);
  currentSource = undefined;
  if (currentSection) currentSection.unload();
  currentSection = undefined;
  book?.destroy?.();
  book = undefined;
  pdfStreams.clear();
  for (const pageNumber of [...renderedPdfPages.keys()]) unrenderPdfPage(pageNumber);
  renderedPdfPages.clear();
  pdfTextContentCache.clear();
  pdfPageLayouts = [];
  const loadingTask = pdfLoadingTask;
  pdfLoadingTask = undefined;
  pdfDocument = undefined;
  if (loadingTask) await loadingTask.destroy().catch(() => {});
  currentIndex = -1;
  currentPdfPage = 1;
  fileHash = "";
  bookTitle = "";
  chapterTitle = "";
  tocEntries = [];
  frame.srcdoc = "";
  frame.hidden = true;
  pdfReader.hidden = true;
  pdfPlaceholder.hidden = true;
  pdfPagesElement.replaceChildren();
  pdfReader.scrollTop = 0;
  toc.replaceChildren();
  showPdfControls(false);
  setControls(false);
}

async function openEpub(file: File) {
  await disposeBook();
  assertReaderSize(file.size);
  setStatus("readerLoading");
  await assertArchiveWithinLimits(file);
  fileHash = await hashFileBytes(file);
  restorePosition = await loadReaderPosition(fileHash);
  book = await makeBook(file);
  if (!book.sections.length) throw new Error("EPUB has no readable spine sections");
  const metadataTitle = typeof book.metadata?.title === "string" ? book.metadata.title.trim() : "";
  bookTitle = metadataTitle || file.name.replace(/\.epub$/i, "");
  document.title = `${bookTitle} · ${t("readerPageTitle")}`;
  tocEntries = flattenToc(book.toc ?? []);
  if (!tocEntries.length) {
    tocEntries = book.sections.map((section, index) => ({
      index,
      label: section.id?.split("/").pop() || t("readerChapter").replace("{number}", String(index + 1)),
    }));
  }
  const epubPosition = isEpubReaderPosition(restorePosition) ? restorePosition : undefined;
  const startIndex = epubPosition && epubPosition.sectionIndex < book.sections.length
    ? epubPosition.sectionIndex
    : 0;
  await writeChapter(startIndex, epubPosition?.sectionIndex === startIndex ? epubPosition : undefined);
  restorePosition = undefined;
  status.textContent = "";
}

async function openPdf(file: File) {
  await disposeBook();
  assertReaderSize(file.size);
  setStatus("readerPdfLoading");
  fileHash = await hashFileBytes(file);
  pdfLoadingTask = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    verbosity: 0,
  });
  pdfDocument = await pdfLoadingTask.promise;
  const metadata = await pdfDocument.getMetadata().catch(() => undefined);
  const info = metadata?.info as { Title?: unknown } | undefined;
  const metadataTitle = typeof info?.Title === "string"
    ? info.Title.trim()
    : "";
  bookTitle = metadataTitle || file.name;
  title.textContent = bookTitle;
  document.title = `${bookTitle} · ${t("readerPageTitle")}`;
  chapterTitle = pageLabel(1);
  frame.hidden = true;
  pdfPlaceholder.hidden = true;
  pdfReader.hidden = false;
  pdfPagesElement.replaceChildren();
  showPdfControls(true);

  for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber++) {
    const page = await pdfDocument.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const element = document.createElement("div");
    element.className = "pdf-page";
    element.setAttribute("aria-label", pageLabel(pageNumber));
    const layout: PdfPageLayout = {
      pageNumber,
      page,
      baseWidth: viewport.width,
      element,
    };
    pdfPageLayouts.push(layout);
    pdfPagesElement.append(element);
  }

  const samplePageCount = Math.min(3, pdfPageLayouts.length);
  const sampleCounts: number[] = [];
  for (let index = 0; index < samplePageCount; index++) {
    const layout = pdfPageLayouts[index];
    const textContent = await layout.page.getTextContent();
    pdfTextContentCache.set(layout.pageNumber, textContent);
    sampleCounts.push(pdfTextCharacterCount(textContent.items));
  }
  if (isPdfFileTextless(sampleCounts, pdfPageLayouts.length)) {
    pdfReader.hidden = true;
    pdfPlaceholder.textContent = t("readerPdfFileNoText");
    pdfPlaceholder.hidden = false;
    showPdfControls(false);
    status.textContent = "";
    restorePosition = undefined;
    return;
  }

  pdfZoomMode = "fit";
  pdfScale = fitPdfScale();
  relayoutPdfPages();
  restorePosition = await loadReaderPosition(fileHash);
  const savedPosition = isPdfReaderPosition(restorePosition) &&
      restorePosition.pageNumber <= pdfPageLayouts.length
    ? restorePosition
    : undefined;
  currentPdfPage = savedPosition?.pageNumber ?? 1;
  updatePdfPageControls(currentPdfPage);

  if (savedPosition) {
    const scrollTop = pdfScrollTopForPosition(savedPosition, pdfGeometries());
    if (scrollTop !== undefined) pdfReader.scrollTop = scrollTop;
    await renderPdfPage(pdfPageLayouts[savedPosition.pageNumber - 1]);
    await waitForPdfLayout();
    const restoredTop = pdfScrollTopForPosition(savedPosition, pdfGeometries());
    if (restoredTop !== undefined) pdfReader.scrollTop = restoredTop;
  }
  await updateVisiblePdfPages();
  handlePdfScroll();
  restorePosition = undefined;
  status.textContent = "";
}

async function openFile(file: File) {
  try {
    if (!isEpub(file) && !isPdf(file)) {
      await disposeBook();
      title.textContent = t("readerNoBook");
      document.title = t("readerPageTitle");
      setStatus("readerInvalidFile");
      return;
    }
    if (isPdf(file)) {
      await openPdf(file);
      return;
    }
    await openEpub(file);
  } catch (error) {
    console.error("Reader error", error);
    await disposeBook();
    title.textContent = t("readerNoBook");
    document.title = t("readerPageTitle");
    setStatus(error instanceof Error && ["readerFileTooLarge", "readerExpandedTooLarge"].includes(error.message)
      ? error.message
      : "readerOpenFailed");
  } finally {
    input.value = "";
  }
}

openButton.addEventListener("click", () => input.click());
input.addEventListener("change", () => {
  const file = input.files?.[0];
  if (file) void openFile(file);
});
toc.addEventListener("change", () => {
  const index = Number(toc.value);
  if (Number.isInteger(index)) void writeChapter(index).catch(() => setStatus("readerOpenFailed"));
});
previous.addEventListener("click", () => {
  if (currentIndex > 0) void writeChapter(currentIndex - 1).catch(() => setStatus("readerOpenFailed"));
});
next.addEventListener("click", () => {
  if (book && currentIndex < book.sections.length - 1)
    void writeChapter(currentIndex + 1).catch(() => setStatus("readerOpenFailed"));
});

pdfReader.addEventListener("scroll", handlePdfScroll, { passive: true });
pdfPreviousPage.addEventListener("click", () => goToPdfPage(currentPdfPage - 1));
pdfNextPage.addEventListener("click", () => goToPdfPage(currentPdfPage + 1));
pdfPageNumber.addEventListener("change", () => {
  const pageNumber = Number(pdfPageNumber.value);
  if (Number.isInteger(pageNumber)) goToPdfPage(pageNumber);
  else updatePdfPageControls();
});
pdfZoom100.addEventListener("click", () =>
  void changePdfZoom("100").catch(() => setStatus("readerOpenFailed")),
);
pdfZoomFit.addEventListener("click", () =>
  void changePdfZoom("fit").catch(() => setStatus("readerOpenFailed")),
);
window.addEventListener("resize", () => {
  if (pdfDocument && pdfZoomMode === "fit")
    void changePdfZoom("fit").catch(() => setStatus("readerOpenFailed"));
});

window.addEventListener("pagehide", () => {
  detachScrollListener();
  void saveCurrentPosition();
  void saveCurrentPdfPosition();
});
