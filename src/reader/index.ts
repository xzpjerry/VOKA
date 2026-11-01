import * as CFI from "foliate-js/epubcfi.js";
import { makeBook, type EpubBook, type EpubSection, type EpubTocItem } from "foliate-js/view.js";
import { BlobReader, configure, ZipReader } from "foliate-js/vendor/zip.js";
import { createReadingSession, READING_HIGHLIGHT_CSS, type ReadingSource } from "../reading-session";
import { t } from "../shared";
import { sanitizeEpubDocument } from "./sanitizer";
import {
  assertReaderSize,
  hashFileBytes,
  loadReaderPosition,
  MAX_READER_FILE_BYTES,
  readerPositionKey,
  saveReaderPosition,
  type ReaderPosition,
} from "./position";
import "./reader.css";

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

type TocEntry = { index: number; label: string };
let book: EpubBook | undefined;
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

document.title = t("readerPageTitle");
document.documentElement.lang = chrome.i18n.getUILanguage().startsWith("zh") ? "zh-CN" : "en";
openButton.textContent = t("readerOpenFile");
title.textContent = t("readerNoBook");
tocLabel.textContent = t("readerContents");
toc.setAttribute("aria-label", t("readerContents"));
previous.textContent = t("readerPreviousChapter");
next.textContent = t("readerNextChapter");
frame.title = t("readerPageTitle");
status.textContent = t("readerChooseFile");

const session = createReadingSession({
  uiDocument: document,
  sources: [],
  sourceLabel: () => ({ site: bookTitle, title: chapterTitle }),
});
void session.start();

function setStatus(key: string) {
  status.textContent = t(key);
}

function setControls(enabled: boolean) {
  toc.disabled = !enabled || tocEntries.length === 0;
  previous.disabled = !enabled || currentIndex <= 0;
  next.disabled = !enabled || !book || currentIndex >= book.sections.length - 1;
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
  const position: ReaderPosition = {
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

async function restoreScroll(doc: Document, position: ReaderPosition) {
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

async function writeChapter(index: number, position?: ReaderPosition) {
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
  pdfPlaceholder.hidden = true;

  if (position) await restoreScroll(chapterFrameDoc, position);
  refreshToc(index);
  previous.disabled = index === 0;
  next.disabled = index === book.sections.length - 1;
  currentSource = { kind: "dom", root: chapterFrameDoc.body };
  session.addSource(currentSource);
  attachScrollListener(chapterFrameDoc);
  setControls(true);
}

async function disposeBook() {
  await saveCurrentPosition();
  detachScrollListener();
  if (currentSource) session.removeSource(currentSource);
  currentSource = undefined;
  if (currentSection) currentSection.unload();
  currentSection = undefined;
  book?.destroy?.();
  book = undefined;
  currentIndex = -1;
  tocEntries = [];
  frame.srcdoc = "";
  frame.hidden = true;
  pdfPlaceholder.hidden = true;
  toc.replaceChildren();
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
  tocEntries = flattenToc(book.toc ?? []);
  if (!tocEntries.length) {
    tocEntries = book.sections.map((section, index) => ({
      index,
      label: section.id?.split("/").pop() || t("readerChapter").replace("{number}", String(index + 1)),
    }));
  }
  const startIndex = restorePosition && restorePosition.sectionIndex < book.sections.length
    ? restorePosition.sectionIndex
    : 0;
  await writeChapter(startIndex, restorePosition?.sectionIndex === startIndex ? restorePosition : undefined);
  restorePosition = undefined;
  status.textContent = "";
}

async function openFile(file: File) {
  try {
    if (!isEpub(file) && !isPdf(file)) {
      await disposeBook();
      title.textContent = t("readerNoBook");
      setStatus("readerInvalidFile");
      return;
    }
    assertReaderSize(file.size);
    if (isPdf(file)) {
      await disposeBook();
      bookTitle = file.name;
      title.textContent = bookTitle;
      pdfPlaceholder.textContent = t("readerPdfSoon");
      pdfPlaceholder.hidden = false;
      frame.hidden = true;
      setStatus("");
      return;
    }
    await openEpub(file);
  } catch (error) {
    console.error("EPUB reader error", error);
    await disposeBook();
    title.textContent = t("readerNoBook");
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

window.addEventListener("pagehide", () => {
  detachScrollListener();
  void saveCurrentPosition();
});
