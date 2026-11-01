import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { strToU8, zipSync } from "fflate";
import puppeteer, { type Browser, type Page } from "puppeteer";
import { checkConnection, rpc } from "../src/background/gateway";
import { CORE_FIELDS, DEFAULT_TARGET, lookup, vokaMeta } from "../src/background/import";
import { createData, type Entry } from "../src/data";
import { normalizeKey } from "../src/key";
import { answerHtml, css, questionHtml } from "../src/data/template";

const PORT = 8766;
const TEST_DECK = "VOKA Test::84";
const NOTE_TYPE = DEFAULT_TARGET.noteType;
const config = { port: PORT, apiKey: "" };
const call = (method: string, params = {}, write = false) =>
  rpc(config, method, params, { sideEffecting: write }) as Promise<any>;
const quote = (value: string) =>
  '"' + value.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
const escapeHtml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const cacheRoot = resolve(".cache/epub-check");
const fixturePath = join(cacheRoot, "reader-fixture.epub");
const TEST_BOOK_TITLE = "VOKA EPUB Test Book";
const TEST_CHAPTER_TITLE = "A Helpful Garden";

assert.equal(await checkConnection(config), "ok", "isolated AnkiConnect on port 8766 must be ready");

const packNames = [
  "cefrj",
  "octanove",
  "oewn",
  "readings",
  "oewn-readings",
  "morphology",
  "gloss-zh",
  "gloss-leveled",
];
const data = createData(
  await Promise.all(
    packNames.map(async (name) =>
      JSON.parse(await readFile(resolve(`public/data/${name}.json`), "utf8")),
    ),
  ),
);
const candidateEntries = data.pack.entries.filter(
  (entry: Entry) => entry.level === "B1" && /^[a-z]{3,18}$/.test(entry.lemma),
);

function createEpub(dueWord: string, targetWord: string) {
  const paragraphs = Array.from({ length: 38 }, (_, index) =>
    `<p>In this chapter, readers consider a useful plan and improve one small part at a time. Example ${index + 1} shows how a clear idea can help a neighbor.</p>`,
  ).join("\n");
  const chapterOne = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
  <head><title>${TEST_CHAPTER_TITLE}</title><meta charset="UTF-8" />
    <link rel="stylesheet" href="reader.css" />
  </head>
  <body><h1>${TEST_CHAPTER_TITLE}</h1>
    <p>An important plan can help a neighbor solve a problem. The word <span id="due-word">${escapeHtml(dueWord)}</span> appears in this synthetic example.</p>
    <p>Another useful example shows <span id="target-word">${escapeHtml(targetWord)}</span> in a sentence with several words.</p>
    <img id="internal-image" src="images/inside.svg" alt="Internal fixture illustration" />
    <img id="external-image" src="https://example.com/x.png" alt="External probe" />
    <script>window.__vokaEpubFixtureScriptRan = true;</script>
    <p>When friends share a clear goal, they can achieve more together.</p>
  </body>
</html>`;
  const chapterTwo = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
  <head><title>Working Together</title><meta charset="UTF-8" />
    <link rel="stylesheet" href="reader.css" />
  </head>
  <body><h1>Working Together</h1><p>This chapter has enough original text to test position restoration.</p>${paragraphs}</body>
</html>`;
  const container = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml" /></rootfiles>
</container>`;
  const packageDoc = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="en">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">urn:voka:test:epub-84</dc:identifier>
    <dc:title>${TEST_BOOK_TITLE}</dc:title><dc:language>en</dc:language>
    <meta property="dcterms:modified">2026-11-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />
    <item id="chapter-one" href="chapter-one.xhtml" media-type="application/xhtml+xml" properties="scripted" />
    <item id="chapter-two" href="chapter-two.xhtml" media-type="application/xhtml+xml" />
    <item id="styles" href="reader.css" media-type="text/css" />
    <item id="inside" href="images/inside.svg" media-type="image/svg+xml" />
  </manifest>
  <spine><itemref idref="chapter-one" /><itemref idref="chapter-two" /></spine>
</package>`;
  const nav = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">
  <head><title>Contents</title></head><body><nav epub:type="toc"><h1>Contents</h1><ol>
    <li><a href="chapter-one.xhtml">${TEST_CHAPTER_TITLE}</a></li>
    <li><a href="chapter-two.xhtml">Working Together</a></li>
  </ol></nav></body>
</html>`;
  const style = `body { font-family: sans-serif; line-height: 1.8; padding: 24px; }\n#internal-image { display: block; width: 80px; height: 48px; }`;
  const internalImage = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="48" viewBox="0 0 80 48"><rect width="80" height="48" rx="8" fill="#2b7a65"/><circle cx="40" cy="24" r="12" fill="#f4d35e"/></svg>`;
  return zipSync(
    {
      mimetype: [strToU8("application/epub+zip"), { level: 0 }],
      "META-INF/container.xml": strToU8(container),
      "OEBPS/content.opf": strToU8(packageDoc),
      "OEBPS/nav.xhtml": strToU8(nav),
      "OEBPS/chapter-one.xhtml": strToU8(chapterOne),
      "OEBPS/chapter-two.xhtml": strToU8(chapterTwo),
      "OEBPS/reader.css": strToU8(style),
      "OEBPS/images/inside.svg": strToU8(internalImage),
    },
    { level: 6 },
  );
}

async function unusedB1Entries(count: number) {
  const unusedEntries: Entry[] = [];
  for (let start = 0; start < candidateEntries.length; start += 100) {
    const batch = candidateEntries.slice(start, start + 100);
    const found = await lookup(
      call,
      DEFAULT_TARGET,
      batch.map((entry: Entry) => normalizeKey(entry.lemma)),
    );
    for (const entry of batch as Entry[]) {
      if ((found.get(normalizeKey(entry.lemma)) ?? []).length) continue;
      unusedEntries.push(entry);
      if (unusedEntries.length === count) return unusedEntries;
    }
  }
  throw new Error(`Fewer than ${count} unused B1 words are available for the EPUB fixture`);
}

async function createDueCard(entry: Entry) {
  const decks = await call("decks.list");
  assert(!decks.some((deck: any) => deck.name === TEST_DECK), `${TEST_DECK} already exists; refusing to touch it`);
  await call("decks.create", { name: TEST_DECK }, true);
  testDeckCreated = true;

  const noteTypes = await call("noteTypes.list");
  if (!noteTypes.some((item: any) => item.name === NOTE_TYPE)) {
    await call(
      "noteTypes.create",
      {
        name: NOTE_TYPE,
        fields: CORE_FIELDS.map((name) => ({ name })),
        templates: [{ name: "词卡", questionHtml, answerHtml }],
        css,
        sortField: "Word",
      },
      true,
    );
  }

  const fields = Object.fromEntries(CORE_FIELDS.map((name) => [name, ""]));
  Object.assign(fields, {
    Key: normalizeKey(entry.lemma),
    Word: escapeHtml(entry.lemma),
    Variants: escapeHtml(entry.Variants ?? ""),
    Reading: escapeHtml(entry.Reading),
    GlossNative: escapeHtml(entry.GlossNative),
    GlossTarget: escapeHtml(entry.GlossTarget),
    VokaMeta: await vokaMeta(entry),
  });
  const validation = await call("notes.validateMany", {
    notes: [{
      noteType: { name: NOTE_TYPE },
      deck: { name: TEST_DECK },
      tags: ["voka", `voka::level::${entry.level}`],
      fields,
    }],
  });
  assert.equal(validation.items[0]?.result?.valid, true, `test note invalid: ${JSON.stringify(validation)}`);
  const created = await call(
    "notes.createMany",
    {
      notes: [{
        noteType: { name: NOTE_TYPE },
        deck: { name: TEST_DECK },
        tags: ["voka", `voka::level::${entry.level}`],
        fields,
      }],
      atomic: false,
    },
    true,
  );
  const noteId = String(created.items[0]?.result?.noteId ?? "");
  assert(noteId, `test note was not created: ${JSON.stringify(created)}`);
  const note = await call("notes.getMany", { ids: [noteId] });
  assert(!note.items[0]?.error && note.items[0]?.result, "test note could not be read");
  const cardId = String(note.items[0].result.cardIds?.[0] ?? "");
  assert(cardId, "test note has no generated card");
  return { noteId, cardId };
}

async function answer(cardId: string, rating: string) {
  const prediction = await call("scheduling.predict", { cardId });
  assert(
    prediction.answers.some((option: any) => option.rating === rating),
    `Anki did not offer ${rating} for ${cardId}`,
  );
  const result = await call(
    "scheduling.answer",
    { cardId, rating, stateToken: prediction.stateToken, elapsedMs: 250 },
    true,
  );
  return result.scheduling ?? call("scheduling.get", { cardId });
}

async function makeDue(cardId: string) {
  const scheduled = await answer(cardId, "easy");
  assert.equal(scheduled.type, "review", "test card must graduate to Review");
  await call("scheduling.setDueDate", { cardIds: [cardId], days: "0" }, true);
  const due = await call("scheduling.getDue", { cardId });
  assert.equal(due.dueNow, true, "test card must be due now");
}

async function searchTestNotes() {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const result = await call("notes.search", {
      query: `note:${quote(NOTE_TYPE)} deck:${quote(TEST_DECK)}`,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    ids.push(...result.ids.map(String));
    cursor = result.nextCursor ?? undefined;
  } while (cursor);
  return ids;
}

async function cleanupTestDeck() {
  const ids = await searchTestNotes();
  if (ids.length)
    for (let start = 0; start < ids.length; start += 100)
      await call("notes.delete", { ids: ids.slice(start, start + 100) }, true);
  const decks = await call("decks.list");
  if (decks.some((deck: any) => deck.name === TEST_DECK))
    await call("decks.delete", { decks: [{ name: TEST_DECK }], deleteCards: true }, true);
  assert.equal((await searchTestNotes()).length, 0, "EPUB test notes were not removed");
  assert(!(await call("decks.list")).some((deck: any) => deck.name === TEST_DECK), "EPUB test deck was not removed");
}

async function watchExternalRequests(page: Page, requests: string[]) {
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    if (request.url().startsWith("https://example.com/")) {
      requests.push(request.url());
      void request.abort();
    } else {
      void request.continue();
    }
  });
}

async function openReaderFromPopup(browser: Browser, popup: Page, readerUrl: string) {
  await popup.bringToFront();
  await popup.click("#openReader");
  const target = await browser.waitForTarget(
    (candidate) => candidate.type() === "page" && candidate.url() === readerUrl,
    { timeout: 30000 },
  );
  const page = await target.page();
  assert(page, "reader tab did not open from the popup");
  return page;
}

let browser: Browser | undefined;
let server: ReturnType<typeof createServer> | undefined;
let testDeckCreated = false;
let testError: unknown;
let sourceEntry: Entry | undefined;
let targetEntry: Entry | undefined;
let testNoteId = "";
let testCardId = "";
let baselineReviewId: unknown;

try {
  await mkdir(cacheRoot, { recursive: true });
  [sourceEntry, targetEntry] = await unusedB1Entries(2);
  const epub = createEpub(sourceEntry.lemma, targetEntry.lemma);
  await writeFile(fixturePath, epub);
  const created = await createDueCard(sourceEntry);
  testNoteId = created.noteId;
  testCardId = created.cardId;
  await makeDue(testCardId);
  baselineReviewId = (await call("reviews.getLatestId", { cardIds: [testCardId] })).id;

  const localFixture = await readFile(resolve("scripts/fixtures/epub-reader.html"), "utf8");
  server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(localFixture);
  });
  await new Promise<void>((resolveListen) => server!.listen(0, "127.0.0.1", resolveListen));
  const localUrl = `http://127.0.0.1:${(server.address() as any).port}/fixture.html`;

  browser = await puppeteer.launch({
    headless: false,
    enableExtensions: [resolve("dist")],
    args: ["--no-first-run"],
  });
  const workerTarget = await browser.waitForTarget((target) => target.type() === "service_worker");
  const worker = (await workerTarget.worker())!;
  const extensionUrls = await worker.evaluate(() => ({
    reader: chrome.runtime.getURL("reader.html"),
    popup: chrome.runtime.getURL("popup.html"),
  }));
  await worker.evaluate(() =>
    chrome.storage.local.set({
      port: 8766,
      apiKey: "",
      targetLevel: "B1",
      nativeLanguage: "zh",
      glossLanguage: "native",
      showAdvanced: false,
      hoverScope: "highlighted",
    }),
  );

  const fixturePage = await browser.newPage();
  await fixturePage.goto(localUrl);
  assert.equal(await fixturePage.$eval("#fixture", (element) => element.textContent), "VOKA synthetic local reader fixture");
  const popup = await browser.newPage();
  await popup.goto(extensionUrls.popup);
  assert.equal(await popup.$eval("#openReader", (button) => (button as HTMLButtonElement).hidden), false);
  let reader = await openReaderFromPopup(browser, popup, extensionUrls.reader);
  reader.on("pageerror", (error) => console.error("reader page error:", error.message));
  reader.on("console", (message) => {
    if (message.type() === "error") console.error("reader console error:", message.text());
  });
  const externalRequests: string[] = [];
  await watchExternalRequests(reader, externalRequests);
  const fileInput = await reader.$("#file-input");
  assert(fileInput, "reader file input missing");
  await fileInput.uploadFile(fixturePath);
  await reader.waitForFunction(
    (expected) => document.querySelector("#book-title")?.textContent === expected,
    { timeout: 30000 },
    TEST_BOOK_TITLE,
  );
  await reader.waitForFunction(
    (word) => {
      const frame = document.querySelector<HTMLIFrameElement>("#epub-frame");
      return frame?.contentDocument?.body?.textContent?.includes(word) ?? false;
    },
    { timeout: 30000 },
    sourceEntry.lemma,
  );
  await reader.waitForFunction(() => {
    const frame = document.querySelector<HTMLIFrameElement>("#epub-frame");
    const image = frame?.contentDocument?.querySelector<HTMLImageElement>("#internal-image");
    return !!image?.complete && image.naturalWidth > 0;
  });

  const security = await reader.$eval("#epub-frame", (element) => {
    const frame = element as HTMLIFrameElement;
    const doc = frame.contentDocument!;
    return {
      sandbox: frame.getAttribute("sandbox"),
      scriptPresent: !!doc.querySelector("script"),
      scriptRan: (frame.contentWindow as any).__vokaEpubFixtureScriptRan === true,
      remoteSrc: doc.querySelector("#external-image")?.getAttribute("src"),
      blockedSrc: doc.querySelector("#external-image")?.getAttribute("data-voka-blocked-src"),
      internalSrc: doc.querySelector("#internal-image")?.getAttribute("src"),
      stylesheetSrc: doc.querySelector('link[rel="stylesheet"]')?.getAttribute("href"),
      csp: doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content"),
      highlightStyles: [...doc.querySelectorAll("style")].some((style) => style.textContent?.includes("::highlight(voka-due)")),
    };
  });
  assert.equal(security.sandbox, "allow-same-origin");
  assert.equal(security.scriptPresent, false, "T-24a chapter scripts must be removed");
  assert.equal(security.scriptRan, false, "T-24a chapter script must not run");
  assert.equal(security.remoteSrc, null);
  assert.equal(security.blockedSrc, "https://example.com/x.png");
  assert.match(security.internalSrc ?? "", /^blob:/, "internal EPUB image must be rewritten to a Blob URL");
  assert.match(security.stylesheetSrc ?? "", /^blob:/, "internal EPUB stylesheet must be rewritten to a Blob URL");
  assert.match(security.csp ?? "", /default-src 'none'/);
  assert.equal(security.highlightStyles, true, "highlight CSS must exist inside the chapter iframe");
  assert.deepEqual(externalRequests, [], "T-24a must not request the external image");

  try {
    await reader.waitForFunction((word, targetWord) => {
      const frame = document.querySelector<HTMLIFrameElement>("#epub-frame");
      const registry = frame?.contentWindow?.CSS?.highlights;
      return (
        [...(registry?.get("voka-target") ?? [])].some((range: any) => range.toString() === targetWord) &&
        [...(registry?.get("voka-due") ?? [])].some((range: any) => range.toString() === word)
      );
    }, { timeout: 12000 }, sourceEntry.lemma, targetEntry.lemma);
  } catch (error) {
    const debug = await reader.evaluate((targetWord) => {
      const frame = document.querySelector<HTMLIFrameElement>("#epub-frame");
      const registry = frame?.contentWindow?.CSS?.highlights;
      const root = document.getElementById("voka-drawer")?.shadowRoot;
      return {
        bodyText: frame?.contentDocument?.body?.textContent,
        targetWord,
        highlightRanges: Object.fromEntries(["voka-target", "voka-due", "voka-learning", "voka-unknown", "voka-weak"].map((name) => [
          name,
          [...(registry?.get(name) ?? [])].map((range: any) => range.toString()),
        ])),
        drawer: root?.textContent,
        dueSummary: root?.querySelector('[data-slot="due-summary"]')?.textContent,
      };
    }, targetEntry.lemma);
    console.error("EPUB highlight debug:", JSON.stringify(debug));
    throw error;
  }
  const childFrame = reader.frames().find((frame) => frame !== reader.mainFrame());
  assert(childFrame, "EPUB iframe was not attached");
  const dueWord = await childFrame.$("#due-word");
  assert(dueWord, "due word is missing from the EPUB fixture");
  await dueWord.hover();
  await reader.waitForFunction((word) => {
    const tooltip = document.getElementById("voka-drawer")?.shadowRoot?.querySelector("[role=tooltip]");
    return !!tooltip && !(tooltip as HTMLElement).hidden && tooltip.textContent?.includes(word);
  }, { timeout: 30000 }, sourceEntry.lemma);
  await dueWord.click();
  await reader.waitForFunction((word) => {
    const card = document.getElementById("voka-drawer")?.shadowRoot?.querySelector("#voka-card");
    return !!card && !(card as HTMLElement).hidden && card.querySelector("h2")?.textContent === word;
  }, { timeout: 30000 }, sourceEntry.lemma);
  await reader.waitForFunction(() => {
    const button = document.getElementById("voka-drawer")?.shadowRoot?.querySelector<HTMLButtonElement>("#voka-save-context");
    return !!button && !button.disabled;
  });
  await reader.evaluate(() =>
    (document.getElementById("voka-drawer")!.shadowRoot!.querySelector("#voka-save-context") as HTMLButtonElement).click(),
  );
  const noteAfterSave = async () => call("notes.getMany", { ids: [testNoteId] });
  let contextSource = "";
  const saveDeadline = Date.now() + 30000;
  while (Date.now() < saveDeadline) {
    const noteResult = await noteAfterSave();
    contextSource = noteResult.items[0]?.result?.fields?.Source1 ?? "";
    if (contextSource) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  }
  assert.match(
    contextSource,
    /^VOKA EPUB Test Book · A Helpful Garden · \d{4}-\d{2}-\d{2}$/,
    "saved example must use book and chapter as its source",
  );

  await reader.click("#next-chapter");
  await reader.waitForFunction(() => document.querySelector("#toc")?.value === "1");
  await reader.waitForFunction(() => document.querySelector("#epub-frame")?.getAttribute("hidden") === null);
  await reader.waitForFunction(() => document.querySelector("#epub-frame")?.getAttribute("srcdoc")?.includes("Working Together") ?? false);
  const secondFrame = reader.frames().find((frame) => frame !== reader.mainFrame());
  assert(secondFrame, "second chapter iframe missing");
  await secondFrame.evaluate(() => {
    const doc = document;
    const max = Math.max(0, (doc.scrollingElement?.scrollHeight ?? 0) - (doc.scrollingElement?.clientHeight ?? 0));
    doc.defaultView?.scrollTo(0, Math.round(max * 0.62));
    doc.defaultView?.dispatchEvent(new Event("scroll"));
  });
  await new Promise((resolveWait) => setTimeout(resolveWait, 1400));
  const hash = createHash("sha256").update(await readFile(fixturePath)).digest("hex");
  const positionKey = `reader-position:${hash}`;
  const savedPosition = await worker.evaluate(async (key) => (await chrome.storage.local.get(key))[key], positionKey) as any;
  assert.equal(savedPosition?.sectionIndex, 1, "reading position must store the active section");
  assert(savedPosition.scrollRatio > 0.2, `reading position did not store scroll progress: ${JSON.stringify(savedPosition)}`);
  assert.match(positionKey, /^reader-position:[a-f\d]{64}$/);
  const storageSnapshot = await worker.evaluate(() => chrome.storage.local.get(null));
  assert(!Object.keys(storageSnapshot).some((key) => key.includes("reader-fixture.epub")));

  await reader.close();
  reader = await openReaderFromPopup(browser, popup, extensionUrls.reader);
  reader.on("pageerror", (error) => console.error("reopened reader page error:", error.message));
  reader.on("console", (message) => {
    if (message.type() === "error") console.error("reopened reader console error:", message.text());
  });
  await watchExternalRequests(reader, externalRequests);
  const reopenedFileInput = await reader.$("#file-input");
  assert(reopenedFileInput, "reader file input missing after reopening");
  await reopenedFileInput.uploadFile(fixturePath);
  await reader.waitForFunction(
    () => document.querySelector("#toc")?.value === "1" &&
      (document.querySelector<HTMLIFrameElement>("#epub-frame")?.contentDocument?.body?.textContent?.includes("Working Together") ?? false),
    { timeout: 30000 },
  );
  const restoredFrame = reader.frames().find((frame) => frame !== reader.mainFrame());
  assert(restoredFrame, "restored chapter iframe missing");
  const restoredRatio = await restoredFrame.evaluate(() => {
    const scrolling = document.scrollingElement!;
    const max = Math.max(1, scrolling.scrollHeight - scrolling.clientHeight);
    return { ratio: scrolling.scrollTop / max, top: scrolling.scrollTop, max };
  });
  assert(restoredRatio.ratio > 0.2, `T-24b position did not restore: ${JSON.stringify(restoredRatio)}`);
  assert.deepEqual(externalRequests, [], "reopening must not request the external image");

  await reader.select("#toc", "0");
  await reader.waitForFunction(() => document.querySelector("#toc")?.value === "0");
  await reader.waitForFunction((word) => {
    const frame = document.querySelector<HTMLIFrameElement>("#epub-frame");
    return [...(frame?.contentWindow?.CSS?.highlights?.get("voka-due") ?? [])].some((range: any) => range.toString() === word);
  }, { timeout: 30000 }, sourceEntry.lemma);
  await reader.waitForFunction(() => {
    const root = document.getElementById("voka-drawer")?.shadowRoot;
    return /1\s+张今日到期|1 due today/i.test(root?.querySelector('[data-slot="due-summary"]')?.textContent ?? "");
  }, { timeout: 30000 });
  await reader.evaluate(() => {
    const root = document.getElementById("voka-drawer")!.shadowRoot!;
    (root.querySelector(".drawer-toggle") as HTMLElement).click();
    (root.querySelector('[data-filter="due"]') as HTMLElement).click();
    (root.querySelector(".drawer-start-review") as HTMLElement).click();
  });
  await reader.waitForFunction((word) => {
    const review = document.getElementById("voka-drawer")?.shadowRoot?.querySelector("#voka-review-question");
    return !!review && review.textContent?.toLowerCase().includes(word.toLowerCase());
  }, { timeout: 30000 }, sourceEntry.lemma);
  await reader.evaluate(() => {
    const root = document.getElementById("voka-drawer")!.shadowRoot!;
    (root.querySelector("#voka-review-ui .review-actions button") as HTMLButtonElement).click();
  });
  await reader.waitForFunction(() => !!document.getElementById("voka-drawer")?.shadowRoot?.querySelector('[data-review-rating="good"]'), { timeout: 30000 });
  await reader.evaluate(() => {
    const root = document.getElementById("voka-drawer")!.shadowRoot!;
    (root.querySelector('[data-review-rating="good"]') as HTMLButtonElement).click();
  });
  await reader.waitForFunction(() => {
    const heading = document.getElementById("voka-drawer")?.shadowRoot?.querySelector("#voka-review-ui h3")?.textContent ?? "";
    return /finished|完了/.test(heading.toLowerCase());
  }, { timeout: 30000 });
  const reviews = await call("reviews.list", {
    cardIds: [testCardId],
    afterId: baselineReviewId,
    limit: 20,
  });
  const matching = reviews.items.filter(
    (item: any) => String(item.cardId) === testCardId && item.rating === "good",
  );
  assert.equal(matching.length, 1, "drawer review must create exactly one Good rating");
  assert.equal(reviews.items.length, 1, "drawer review must create only one review record after the baseline");

  console.log(JSON.stringify({
    port: PORT,
    testDeck: TEST_DECK,
    dueWord: sourceEntry.lemma,
    targetWord: targetEntry.lemma,
    checks: [
      "popup opens the built reader page from a local fixture tab",
      "EPUB metadata, two chapters, internal image and styles render",
      "scripts and external resources are removed before sandbox rendering (T-24a)",
      "reading session highlights the due word, shows tooltip and full card, and saves the book/chapter source",
      "chapter navigation and SHA-256 position restore work (T-24b)",
      "drawer review submits one Good rating recorded by reviews.list",
    ],
  }, null, 2));
} catch (error) {
  testError = error;
} finally {
  await browser?.close();
  if (server?.listening)
    await new Promise<void>((resolveClose, rejectClose) =>
      server!.close((error) => (error ? rejectClose(error) : resolveClose())),
    );
  if (testDeckCreated) await cleanupTestDeck();
  await rm(cacheRoot, { recursive: true, force: true });
  console.log("CLEANUP OK");
}

if (testError) throw testError;
