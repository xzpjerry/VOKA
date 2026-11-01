import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import puppeteer, { type Browser, type Page } from "puppeteer";
import { checkConnection, GatewayError, rpc } from "../src/background/gateway";
import { CORE_FIELDS, DEFAULT_TARGET, lookup, vokaMeta } from "../src/background/import";
import { createData, type Entry } from "../src/data";
import { normalizeKey } from "../src/key";
import { answerHtml, css, questionHtml } from "../src/data/template";

const PORT = 8766;
const TEST_DECK = "VOKA Test::86";
const NOTE_TYPE = DEFAULT_TARGET.noteType;
const TEST_PDF_TITLE = "VOKA PDF Test Document";
const config = { port: PORT, apiKey: "" };
const rpcTraceEnabled = process.env.VOKA_RPC_LOG === "1";
async function call(method: string, params = {}, write = false): Promise<any> {
  const startedAt = Date.now();
  try {
    const result = await rpc(config, method, params, { sideEffecting: write });
    if (rpcTraceEnabled)
      console.log(
        `[VOKA_SCRIPT_RPC] ${JSON.stringify({ method, startedAt: new Date(startedAt).toISOString(), durationMs: Date.now() - startedAt, outcome: "ok" })}`,
      );
    return result;
  } catch (error) {
    if (rpcTraceEnabled) {
      const outcome =
        error instanceof Error && error.name === "RpcTimeoutError"
          ? error instanceof GatewayError && error.outcome === "unknown"
            ? "timeout-unknown"
            : "timeout"
          : error instanceof GatewayError
            ? error.status
            : "error";
      console.log(
        `[VOKA_SCRIPT_RPC] ${JSON.stringify({ method, startedAt: new Date(startedAt).toISOString(), durationMs: Date.now() - startedAt, outcome })}`,
      );
    }
    throw error;
  }
}
const quote = (value: string) =>
  '"' + value.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
const escapeHtml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const cacheRoot = resolve(".cache/pdf-check");
const textPdfPath = join(cacheRoot, "text-reader.pdf");
const imagePdfPath = join(cacheRoot, "image-only-reader.pdf");

assert.equal(
  await checkConnection(config),
  "ok",
  "isolated AnkiConnect on port 8766 must be ready",
);

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

function createTextPdf(dueWords: string[], practiceWord: string, firstWord: string, thirdWord: string) {
  const pdf = PDFDocument.create();
  return pdf.then(async (document) => {
    document.setTitle(TEST_PDF_TITLE);
    const font = await document.embedFont(StandardFonts.Helvetica);
    const splitFont = await document.embedFont(StandardFonts.HelveticaBold);
    const pageOne = document.addPage([612, 792]);
    pageOne.drawText("A Garden Reading", { x: 60, y: 710, size: 24, font });
    pageOne.drawText(
      `This ${firstWord} and ${dueWords[0]} appear in a useful example for English readers.`,
      { x: 60, y: 650, size: 16, font },
    );
    pageOne.drawText("A clear plan helps a neighbor understand a new idea.", {
      x: 60,
      y: 614,
      size: 16,
      font,
    });

    const pageTwo = document.addPage([612, 792]);
    pageTwo.drawText("A Complete Example", { x: 60, y: 710, size: 24, font });
    const size = 16;
    const y = 650;
    const left = "The clear example shows ";
    const dueWord = dueWords[1];
    const firstPart = dueWord.slice(0, Math.ceil(dueWord.length / 2));
    const secondPart = dueWord.slice(firstPart.length);
    pageTwo.drawText(left, { x: 60, y, size, font });
    let x = 60 + font.widthOfTextAtSize(left, size);
    pageTwo.drawText(firstPart, { x, y, size, font });
    x += font.widthOfTextAtSize(firstPart, size);
    pageTwo.drawText(secondPart, { x, y, size, font: splitFont });
    x += splitFont.widthOfTextAtSize(secondPart, size);
    pageTwo.drawText(" works in a full sentence for language learners.", {
      x,
      y,
      size,
      font,
    });
    pageTwo.drawText("Readers can save this complete sentence as context.", {
      x: 60,
      y: 614,
      size,
      font,
    });
    pageTwo.drawText(`A second example includes ${dueWords[2]} for learners.`, {
      x: 60,
      y: 578,
      size,
      font,
    });

    const pageThree = document.addPage([612, 792]);
    pageThree.drawText("A Final Page", { x: 60, y: 710, size: 24, font });
    pageThree.drawText(`The practice word ${practiceWord} starts near the top of page three.`, {
      x: 60,
      y: 670,
      size: 16,
      font,
    });
    pageThree.drawText(`The due word ${dueWords[3]} appears on this page.`, {
      x: 60,
      y: 630,
      size: 16,
      font,
    });
    pageThree.drawText(
      `The word ${thirdWord} appears on the final page of this local reader fixture.`,
      { x: 60, y: 650, size: 16, font },
    );
    return document.save();
  });
}

async function unusedB1Entries(count: number) {
  const unusedEntries: Entry[] = [];
  const seenKeys = new Set<string>();
  for (let start = 0; start < candidateEntries.length; start += 100) {
    const batch = candidateEntries.slice(start, start + 100);
    const found = await lookup(
      call,
      DEFAULT_TARGET,
      batch.map((entry: Entry) => normalizeKey(entry.lemma)),
    );
    for (const entry of batch as Entry[]) {
      const key = normalizeKey(entry.lemma);
      if (seenKeys.has(key) || (found.get(key) ?? []).length) continue;
      seenKeys.add(key);
      unusedEntries.push(entry);
      if (unusedEntries.length === count) return unusedEntries;
    }
  }
  throw new Error(`Fewer than ${count} unused B1 words are available for the PDF fixture`);
}

async function createTestCards(candidates: Entry[]) {
  const decks = await call("decks.list");
  assert(
    !decks.some((deck: any) => deck.name === TEST_DECK),
    `${TEST_DECK} already exists; refusing to touch it`,
  );
  deckWasAbsent = true;
  deckCreateAttempted = true;
  await call("decks.create", { name: TEST_DECK }, true);

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

  const cards: { entry: Entry; noteId: string; cardId: string }[] = [];
  for (const entry of candidates) {
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
    const note = {
      noteType: { name: NOTE_TYPE },
      deck: { name: TEST_DECK },
      tags: ["voka", `voka::level::${entry.level}`],
      fields,
    };
    const validation = await call("notes.validateMany", { notes: [note] });
    if (validation.items[0]?.result?.valid !== true) {
      const duplicateOnly = validation.items[0]?.result?.issues?.every(
        (issue: any) => issue.type === "duplicate",
      );
      if (duplicateOnly) continue;
      throw new Error(`PDF test note invalid: ${JSON.stringify(validation)}`);
    }
    const created = await call("notes.createMany", { notes: [note], atomic: false }, true);
    const noteId = String(created.items[0]?.result?.noteId ?? "");
    assert(noteId, `PDF test note was not created: ${JSON.stringify(created)}`);
    const noteResult = await call("notes.getMany", { ids: [noteId] });
    assert(!noteResult.items[0]?.error && noteResult.items[0]?.result, "PDF test note could not be read");
    const cardId = String(noteResult.items[0].result.cardIds?.[0] ?? "");
    assert(cardId, "PDF test note has no generated card");
    cards.push({ entry, noteId, cardId });
  }
  assert.equal(cards.length, candidates.length, "all PDF test cards must be created");
  return cards;
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
  let scheduled = await answer(cardId, "easy");
  for (let attempt = 0; scheduled.type !== "review" && attempt < 20; attempt++)
    scheduled = await answer(cardId, "easy");
  assert.equal(scheduled.type, "review", "PDF test card must graduate to Review");
  await call("scheduling.setDueDate", { cardIds: [cardId], days: "0" }, true);
  const due = await call("scheduling.getDue", { cardId });
  assert.equal(due.dueNow, true, "PDF test card must be due now");
}

async function makeFuture(cardId: string) {
  let scheduled = await answer(cardId, "easy");
  for (let attempt = 0; scheduled.type !== "review" && attempt < 20; attempt++)
    scheduled = await answer(cardId, "easy");
  assert.equal(scheduled.type, "review", "PDF practice card must graduate to Review");
  await call("scheduling.setDueDate", { cardIds: [cardId], days: "10" }, true);
  assert.equal((await call("scheduling.getDue", { cardId })).dueNow, false, "PDF practice card must not be due today");
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
  const decks = await call("decks.list");
  if (!decks.some((deck: any) => deck.name === TEST_DECK)) return;
  const ids = await searchTestNotes();
  for (let start = 0; start < ids.length; start += 100)
    await call("notes.delete", { ids: ids.slice(start, start + 100) }, true);
  assert.equal((await searchTestNotes()).length, 0, "PDF test notes were not removed");
  await call("decks.delete", { decks: [{ name: TEST_DECK }], deleteCards: true }, true);
  assert(
    !(await call("decks.list")).some((deck: any) => deck.name === TEST_DECK),
    "PDF test deck was not removed",
  );
}

async function watchReaderRequests(page: Page, urls: string[]) {
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    urls.push(request.url());
    void request.continue();
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
let deckWasAbsent = false;
let deckCreateAttempted = false;
let testError: unknown;
let dueEntry: Entry | undefined;
let dueEntries: Entry[] = [];
let practiceEntry: Entry | undefined;
let firstEntry: Entry | undefined;
let thirdEntry: Entry | undefined;
let testCards: { entry: Entry; noteId: string; cardId: string }[] = [];
let baselineReviewIds: unknown[] = [];

try {
  await mkdir(cacheRoot, { recursive: true });
  const candidates = await unusedB1Entries(20);
  dueEntries = candidates.slice(0, 4);
  practiceEntry = candidates[4];
  firstEntry = candidates[5];
  thirdEntry = candidates[6];
  dueEntry = dueEntries[1];
  assert(practiceEntry && firstEntry && thirdEntry, "PDF fixture needs four due entries, one practice entry, and two target entries");
  testCards = await createTestCards([...dueEntries, practiceEntry]);
  for (const card of testCards.slice(0, 4)) await makeDue(card.cardId);
  await makeFuture(testCards[4].cardId);
  const dueCards = testCards.slice(0, 4);
  baselineReviewIds = await Promise.all(
    dueCards.map(async (card) =>
      (await call("reviews.getLatestId", { cardIds: [card.cardId] })).id,
    ),
  );
  const baselineDueStates = await Promise.all(
    dueCards.map((card) => call("scheduling.get", { cardId: card.cardId })),
  );
  const baselinePracticeReviewId = (
    await call("reviews.getLatestId", { cardIds: [testCards[4].cardId] })
  ).id;
  const baselinePracticeState = await call("scheduling.get", { cardId: testCards[4].cardId });
  await writeFile(
    textPdfPath,
    await createTextPdf(dueEntries.map((entry) => entry.lemma), practiceEntry.lemma, firstEntry.lemma, thirdEntry.lemma),
  );

  const fixtureHtml = await readFile(resolve("scripts/fixtures/pdf-reader.html"), "utf8");
  server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(fixtureHtml);
  });
  await new Promise<void>((resolveListen) => server!.listen(0, "127.0.0.1", resolveListen));
  const localUrl = `http://127.0.0.1:${(server.address() as any).port}/scan-fixture.html`;

  browser = await puppeteer.launch({
    headless: false,
    enableExtensions: [resolve("dist")],
    args: ["--no-first-run", "--lang=zh-CN"],
  });
  const workerTarget = await browser.waitForTarget((target) => target.type() === "service_worker");
  if (rpcTraceEnabled) {
    const trace = await workerTarget.createCDPSession();
    await trace.send("Runtime.enable");
    trace.on("Runtime.consoleAPICalled", (event) => {
      const message = event.args
        .map((argument) => argument.value ?? argument.description ?? "")
        .join(" ");
      if (message.includes("[VOKA_RPC]"))
        console.log(`[VOKA_SERVICE_WORKER] ${message}`);
    });
  }
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
  await fixturePage.setViewport({ width: 900, height: 1165, deviceScaleFactor: 1 });
  await fixturePage.goto(localUrl);
  const scannedImage = await fixturePage.screenshot({ type: "png", fullPage: true });
  const imagePdf = await PDFDocument.create();
  const imagePage = imagePdf.addPage([612, 792]);
  const embeddedImage = await imagePdf.embedPng(scannedImage);
  imagePage.drawImage(embeddedImage, { x: 24, y: 24, width: 564, height: 744 });
  await writeFile(imagePdfPath, await imagePdf.save());
  await fixturePage.close();

  const popup = await browser.newPage();
  await popup.goto(extensionUrls.popup);
  assert.equal(await popup.$eval("#openReader", (button) => (button as HTMLButtonElement).hidden), false);
  let reader = await openReaderFromPopup(browser, popup, extensionUrls.reader);
  await reader.waitForFunction(() => document.readyState === "complete");
  reader.on("pageerror", (error) => console.error("reader page error:", error.message));
  reader.on("console", (message) => {
    if (message.type() === "error") console.error("reader console error:", message.text());
  });
  const readerRequests: string[] = [];
  await watchReaderRequests(reader, readerRequests);
  const fileInput = await reader.$("#file-input");
  assert(fileInput, "reader file input missing");
  await fileInput.uploadFile(textPdfPath);

  try {
    await reader.waitForFunction(
      (expected) => document.querySelector("#book-title")?.textContent === expected,
      { timeout: 30000 },
      TEST_PDF_TITLE,
    );
  } catch (error) {
    const state = await reader.evaluate(() => ({
      title: document.querySelector("#book-title")?.textContent,
      status: document.querySelector("#reader-status")?.textContent,
      placeholder: document.querySelector("#pdf-placeholder")?.textContent,
      inputFileCount: document.querySelector<HTMLInputElement>("#file-input")?.files?.length,
      pdfReaderHidden: (document.querySelector("#pdf-reader") as HTMLElement | null)?.hidden,
    }));
    console.error("PDF opening state:", JSON.stringify(state));
    throw error;
  }
  await reader.waitForFunction(
    () => document.querySelectorAll(".pdf-text-layer").length >= 2,
    { timeout: 30000 },
  );
  assert.equal(await reader.$eval("#pdf-page-total", (element) => element.textContent), "3");

  await reader.waitForFunction((word, target) => {
    const due = [...(CSS.highlights.get("voka-due") ?? [])].some((range: any) => range.toString() === word);
    const targetWord = [...(CSS.highlights.get("voka-target") ?? [])].some((range: any) => range.toString() === target);
    return due && targetWord;
  }, { timeout: 30000 }, dueEntry.lemma, firstEntry.lemma);
  const highlightState = await reader.evaluate((word, target) => {
    const due = [...(CSS.highlights.get("voka-due") ?? [])]
      .find((range: any) => range.toString() === word) as Range | undefined;
    const targetRange = [...(CSS.highlights.get("voka-target") ?? [])]
      .find((range: any) => range.toString() === target) as Range | undefined;
    return {
      dueOnTextLayer: !!due?.startContainer.parentElement?.closest(".pdf-text-layer"),
      targetOnTextLayer: !!targetRange?.startContainer.parentElement?.closest(".pdf-text-layer"),
      dueWordSplitAcrossNodes: !!due && due.startContainer !== due.endContainer,
    };
  }, dueEntry.lemma, firstEntry.lemma);
  assert.equal(highlightState.dueOnTextLayer, true, "due underline range must be on the PDF text layer");
  assert.equal(highlightState.targetOnTextLayer, true, "target highlight range must be on the PDF text layer");

  await reader.click("#pdf-next-page");
  await reader.waitForFunction(() => document.querySelector<HTMLInputElement>("#pdf-page-number")?.value === "2");
  await reader.click("#pdf-previous-page");
  await reader.waitForFunction(() => document.querySelector<HTMLInputElement>("#pdf-page-number")?.value === "1");
  await reader.click("#pdf-next-page");
  await reader.waitForFunction(() => document.querySelector<HTMLInputElement>("#pdf-page-number")?.value === "2");
  await reader.$eval("#pdf-page-number", (input: HTMLInputElement) => {
    input.value = "3";
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await reader.waitForFunction(() => document.querySelector<HTMLInputElement>("#pdf-page-number")?.value === "3");
  await reader.$eval("#pdf-page-number", (input: HTMLInputElement) => {
    input.value = "2";
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await reader.waitForFunction(() => document.querySelector<HTMLInputElement>("#pdf-page-number")?.value === "2");
  await reader.click("#pdf-zoom-100");
  await reader.waitForFunction(() => document.querySelector<HTMLButtonElement>("#pdf-zoom-100")?.getAttribute("aria-pressed") === "true");
  await reader.waitForFunction((word) =>
    [...(CSS.highlights.get("voka-due") ?? [])].some((range: any) => range.toString() === word),
    { timeout: 30000 },
    dueEntry.lemma,
  );
  await reader.click("#pdf-zoom-fit");
  await reader.waitForFunction(() => document.querySelector<HTMLButtonElement>("#pdf-zoom-fit")?.getAttribute("aria-pressed") === "true");
  await reader.waitForFunction((word) =>
    [...(CSS.highlights.get("voka-due") ?? [])].some((range: any) => range.toString() === word),
    { timeout: 30000 },
    dueEntry.lemma,
  );
  await new Promise((resolveWait) => setTimeout(resolveWait, 1500));
  await reader.waitForFunction((word) =>
    [...(CSS.highlights.get("voka-due") ?? [])].some((range: any) => range.toString() === word),
    { timeout: 30000 },
    dueEntry.lemma,
  );
  assert.equal(highlightState.dueWordSplitAcrossNodes, true, "PDF fixture should split the due word across text-layer nodes");

  const dueRect = await reader.evaluate((word) => {
    const range = [...(CSS.highlights.get("voka-due") ?? [])]
      .find((candidate: any) => candidate.toString() === word) as Range | undefined;
    const rect = range?.getClientRects()[0];
    return rect ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null;
  }, dueEntry.lemma);
  assert(dueRect, "due text layer range must have a visible rectangle");
  await reader.mouse.move(dueRect.x, dueRect.y);
  await reader.waitForFunction((word) => {
    const tooltip = document.getElementById("voka-drawer")?.shadowRoot?.querySelector<HTMLElement>("[role=tooltip]");
    return !!tooltip && !tooltip.hidden && tooltip.textContent?.includes(word);
  }, { timeout: 30000 }, dueEntry.lemma);
  await reader.mouse.click(dueRect.x, dueRect.y);
  await reader.waitForFunction((word) => {
    const card = document.getElementById("voka-drawer")?.shadowRoot?.querySelector<HTMLElement>("#voka-card");
    return !!card && !card.hidden && card.querySelector("h2")?.textContent === word;
  }, { timeout: 30000 }, dueEntry.lemma);
  const sentence = await reader.$eval(
    "#voka-drawer",
    (host, word) => {
      const root = host.shadowRoot!;
      const card = root.querySelector("#voka-card")!;
      return [...card.querySelectorAll("p")].map((paragraph) => paragraph.textContent ?? "").find((text) => text.includes(word)) ?? "";
    },
    dueEntry.lemma,
  );
  assert.match(sentence, new RegExp(`The clear example shows ${dueEntry.lemma} works in a full sentence`, "i"));
  try {
    await reader.waitForFunction(() => {
      const button = document.getElementById("voka-drawer")?.shadowRoot?.querySelector<HTMLButtonElement>("#voka-save-context");
      return !!button && !button.disabled;
    });
  } catch (error) {
    const state = await reader.evaluate(() => {
      const root = document.getElementById("voka-drawer")?.shadowRoot;
      const button = root?.querySelector<HTMLButtonElement>("#voka-save-context");
      const card = root?.querySelector<HTMLElement>("#voka-card");
      return {
        disabled: button?.disabled,
        buttonText: button?.textContent,
        cardText: card?.textContent,
        cardHtml: card?.innerHTML,
      };
    });
    console.error("PDF context save state:", JSON.stringify(state));
    throw error;
  }
  await reader.evaluate(() =>
    (document.getElementById("voka-drawer")!.shadowRoot!.querySelector("#voka-save-context") as HTMLButtonElement).click(),
  );

  const noteId = testCards[1].noteId;
  let savedNote: any;
  const saveDeadline = Date.now() + 30000;
  while (Date.now() < saveDeadline) {
    savedNote = await call("notes.getMany", { ids: [noteId] });
    if (savedNote.items[0]?.result?.fields?.Source1) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  }
  const source = String(savedNote?.items[0]?.result?.fields?.Source1 ?? "");
  assert.match(
    source,
    new RegExp(`^${TEST_PDF_TITLE} · (第 2 页|Page 2) · \\d{4}-\\d{2}-\\d{2}$`),
    "saved example source must contain the PDF title, page 2, and date",
  );
  await reader.keyboard.press("Escape");

  await reader.waitForFunction(() => document.querySelectorAll(".pdf-text-layer").length >= 3);
  await reader.evaluate(() => {
    const container = document.querySelector<HTMLElement>("#pdf-reader")!;
    const pages = [...document.querySelectorAll<HTMLElement>(".pdf-page")];
    const pageTwo = pages[1]!;
    container.scrollTop = pageTwo.offsetTop + pageTwo.offsetHeight - 100;
    container.dispatchEvent(new Event("scroll"));
  });
  await reader.waitForFunction(() => document.querySelector<HTMLInputElement>("#pdf-page-number")?.value === "2");
  const currentPageDuringExampleSave = await reader.$eval(
    "#pdf-page-number",
    (input) => input.value,
  );
  assert.equal(currentPageDuringExampleSave, "2", "page 2 must remain the current PDF page during the page 3 example save");
  const practiceRect = await reader.evaluate((word) => {
    const range = ["voka-target", "voka-learning", "voka-unknown", "voka-weak"]
      .flatMap((name) => [...(CSS.highlights.get(name) ?? [])])
      .find((candidate: any) => candidate.toString() === word) as Range | undefined;
    const rect = range?.getClientRects()[0];
    return rect ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null;
  }, practiceEntry.lemma);
  assert(practiceRect, "page 3 practice word must be visible while page 2 is current");
  await reader.mouse.click(practiceRect.x, practiceRect.y);
  await reader.waitForFunction((word) => {
    const card = document.getElementById("voka-drawer")?.shadowRoot?.querySelector<HTMLElement>("#voka-card");
    return !!card && !card.hidden && card.querySelector("h2")?.textContent === word;
  }, { timeout: 30000 }, practiceEntry.lemma);
  await reader.waitForFunction(() => {
    const button = document.getElementById("voka-drawer")?.shadowRoot?.querySelector<HTMLButtonElement>("#voka-save-context");
    return !!button && !button.disabled;
  });
  await reader.evaluate(() =>
    (document.getElementById("voka-drawer")!.shadowRoot!.querySelector("#voka-save-context") as HTMLButtonElement).click(),
  );
  let practiceNote: any;
  const practiceSaveDeadline = Date.now() + 30000;
  while (Date.now() < practiceSaveDeadline) {
    practiceNote = await call("notes.getMany", { ids: [testCards[4].noteId] });
    if (practiceNote.items[0]?.result?.fields?.Source1) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  }
  const pageThreeSource = String(practiceNote?.items[0]?.result?.fields?.Source1 ?? "");
  assert.match(
    pageThreeSource,
    new RegExp(`^${TEST_PDF_TITLE} · (第 3 页|Page 3) · \\d{4}-\\d{2}-\\d{2}$`),
    "#106 example source must use the localized label for the token's page 3 while page 2 is current",
  );
  await reader.waitForFunction(() =>
    !!document.getElementById("voka-drawer")?.shadowRoot?.querySelector("#voka-practice-word"),
  { timeout: 30000 });
  const practiceBefore = {
    latestReviewId: (await call("reviews.getLatestId", { cardIds: [testCards[4].cardId] })).id,
    scheduling: await call("scheduling.get", { cardId: testCards[4].cardId }),
  };
  assert.equal(practiceBefore.latestReviewId, baselinePracticeReviewId);
  assert.deepEqual(practiceBefore.scheduling, baselinePracticeState);
  await reader.evaluate(() =>
    (document.getElementById("voka-drawer")!.shadowRoot!.querySelector("#voka-practice-word") as HTMLButtonElement).click(),
  );
  await reader.waitForFunction((word) => {
    const root = document.getElementById("voka-drawer")?.shadowRoot;
    const view = root?.querySelector<HTMLElement>("#voka-review-ui");
    return !!view && !view.hidden && /练习 · 不计入 Anki|Practice · not recorded in Anki/i.test(view.querySelector(".practice-label")?.textContent ?? "") &&
      root?.querySelector("#voka-review-question")?.textContent?.toLowerCase().includes(word.toLowerCase()) === true &&
      view.querySelectorAll("[data-review-rating]").length === 0;
  }, { timeout: 30000 }, practiceEntry.lemma);
  await reader.evaluate(() =>
    (document.getElementById("voka-drawer")!.shadowRoot!.querySelector('[data-practice-action="show-answer"]') as HTMLButtonElement).click(),
  );
  await reader.waitForFunction(() => {
    const root = document.getElementById("voka-drawer")?.shadowRoot;
    const view = root?.querySelector<HTMLElement>("#voka-review-ui");
    return !!root?.querySelector("#voka-review-answer") &&
      !!view?.querySelector('[data-practice-action="next"]') &&
      view.querySelectorAll("[data-review-rating]").length === 0;
  }, { timeout: 30000 });
  await reader.evaluate(() =>
    (document.getElementById("voka-drawer")!.shadowRoot!.querySelector('[data-practice-action="next"]') as HTMLButtonElement).click(),
  );
  await reader.waitForFunction(() =>
    document.getElementById("voka-drawer")?.shadowRoot?.querySelector<HTMLElement>("#voka-review-ui")?.hidden === true,
  { timeout: 30000 });
  assert.deepEqual(
    {
      latestReviewId: (await call("reviews.getLatestId", { cardIds: [testCards[4].cardId] })).id,
      scheduling: await call("scheduling.get", { cardId: testCards[4].cardId }),
    },
    practiceBefore,
    "PDF practice must not change its review id or scheduling state",
  );
  await reader.waitForFunction(() => {
    const text = document.getElementById("voka-drawer")?.shadowRoot?.querySelector('[data-slot="due-summary"]')?.textContent ?? "";
    return /4\s+张今日到期|4 due today/i.test(text);
  }, { timeout: 30000 });

  await reader.evaluate(() => {
    const container = document.querySelector<HTMLElement>("#pdf-reader")!;
    const page = document.querySelector<HTMLElement>('.pdf-page[aria-label="第 3 页"], .pdf-page[aria-label="Page 3"]')!;
    container.scrollTop = page.offsetTop + page.offsetHeight * 0.38;
    container.dispatchEvent(new Event("scroll"));
  });
  await reader.waitForFunction(() => document.querySelector<HTMLInputElement>("#pdf-page-number")?.value === "3");
  await new Promise((resolveWait) => setTimeout(resolveWait, 1300));
  const hash = createHash("sha256").update(await readFile(textPdfPath)).digest("hex");
  const positionKey = `reader-position:${hash}`;
  const savedPosition = await worker.evaluate(async (key) => (await chrome.storage.local.get(key))[key], positionKey) as any;
  assert.equal(savedPosition?.pageNumber, 3, "PDF position must store the current page number");
  assert(savedPosition.normalizedPageOffset > 0.2, "PDF position must store a normalized in-page offset");
  const storageSnapshot = await worker.evaluate(() => chrome.storage.local.get(null));
  assert(!Object.keys(storageSnapshot).some((key) => key.includes("text-reader.pdf")), "reader must not store the file path");

  await reader.close();
  reader = await openReaderFromPopup(browser, popup, extensionUrls.reader);
  await reader.waitForFunction(() => document.readyState === "complete");
  reader.on("pageerror", (error) => console.error("reopened reader page error:", error.message));
  reader.on("console", (message) => {
    if (message.type() === "error") console.error("reopened reader console error:", message.text());
  });
  await watchReaderRequests(reader, readerRequests);
  const reopenedInput = await reader.$("#file-input");
  assert(reopenedInput, "reader file input missing after reopening");
  await reopenedInput.uploadFile(textPdfPath);
  await reader.waitForFunction(
    () => document.querySelector<HTMLInputElement>("#pdf-page-number")?.value === "3" &&
      document.querySelectorAll(".pdf-text-layer").length >= 2,
    { timeout: 30000 },
  );

  await reader.$eval("#pdf-page-number", (input: HTMLInputElement) => {
    input.value = "2";
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await reader.waitForFunction(() => document.querySelector<HTMLInputElement>("#pdf-page-number")?.value === "2");
  await reader.waitForFunction(() => {
    const root = document.getElementById("voka-drawer")?.shadowRoot;
    return /4\s+张今日到期|4 due today/i.test(root?.querySelector('[data-slot="due-summary"]')?.textContent ?? "");
  }, { timeout: 30000 });
  await reader.evaluate(() => {
    const root = document.getElementById("voka-drawer")!.shadowRoot!;
    (root.querySelector(".drawer-toggle") as HTMLElement).click();
    (root.querySelector('[data-filter="due"]') as HTMLElement).click();
  });
  const dueListCount = await reader.$eval(
    "#voka-drawer",
    (host) => host.shadowRoot!.querySelectorAll(".drawer-list li").length,
  );
  assert.equal(dueListCount, 4, "PDF due filter must list all four due words across pages 1–3");
  await reader.evaluate(() =>
    (document.getElementById("voka-drawer")!.shadowRoot!.querySelector('[data-slot="review-button"]') as HTMLButtonElement).click(),
  );
  await reader.waitForFunction((word) => {
    const review = document.getElementById("voka-drawer")?.shadowRoot?.querySelector("#voka-review-question");
    return !!review && review.textContent?.toLowerCase().includes(word.toLowerCase());
  }, { timeout: 30000 }, dueEntries[0].lemma);
  const ratings = ["again", "hard", "good", "easy"] as const;
  for (let index = 0; index < 4; index++) {
    const current = testCards[index];
    const rating = ratings[index];
    await reader.waitForFunction((word) => {
      const root = document.getElementById("voka-drawer")?.shadowRoot;
      const view = root?.querySelector<HTMLElement>("#voka-review-ui");
      return root?.querySelector("#voka-review-question")?.textContent?.toLowerCase().includes(word.toLowerCase()) === true &&
        !!view?.querySelector(".review-actions button:not([data-review-rating])");
    }, { timeout: 30000 }, current.entry.lemma);
    await reader.evaluate(() => {
      const root = document.getElementById("voka-drawer")!.shadowRoot!;
      (root.querySelector("#voka-review-ui .review-actions button:not([data-review-rating])") as HTMLButtonElement).click();
    });
    await reader.waitForFunction((value) =>
      !!document.getElementById("voka-drawer")?.shadowRoot?.querySelector("#voka-review-answer") &&
      !!document.getElementById("voka-drawer")?.shadowRoot?.querySelector(`[data-review-rating="${value}"]`),
    { timeout: 30000 }, rating);
    await reader.evaluate((value) => {
      const root = document.getElementById("voka-drawer")!.shadowRoot!;
      (root.querySelector(`[data-review-rating="${value}"]`) as HTMLButtonElement).click();
    }, rating);
    const remaining = 3 - index;
    await reader.waitForFunction((expected) => {
      const text = document.getElementById("voka-drawer")?.shadowRoot?.querySelector('[data-slot="due-summary"]')?.textContent ?? "";
      if (expected === 0) return /本页没有今日到期的词|Nothing due today/i.test(text);
      const count = Number(text.match(/(\d+)\s*(?:张今日到期|due today)/i)?.[1]);
      return count === expected;
    }, { timeout: 30000 }, remaining);
    await reader.waitForFunction((word, finished) => {
      const root = document.getElementById("voka-drawer")?.shadowRoot;
      const heading = root?.querySelector("#voka-review-ui h3")?.textContent ?? "";
      const question = root?.querySelector("#voka-review-question")?.textContent ?? "";
      return finished
        ? /复习完了|finished/i.test(heading)
        : question.toLowerCase().includes(word.toLowerCase());
    }, { timeout: 30000 }, testCards[index + 1]?.entry.lemma ?? "", index === 3);
    const records = await call("reviews.list", {
      cardIds: [current.cardId],
      afterId: baselineReviewIds[index],
      limit: 20,
    });
    const matching = records.items.filter(
      (item: any) => String(item.cardId) === current.cardId && item.rating === rating,
    );
    assert.equal(matching.length, 1, `PDF review must record exactly one ${rating} rating for ${current.entry.lemma}`);
    assert.equal(records.items.length, 1, `PDF review must create only one record for ${current.entry.lemma}`);
    assert.notDeepEqual(
      await call("scheduling.get", { cardId: current.cardId }),
      baselineDueStates[index],
      `PDF ${rating} review must update scheduling for ${current.entry.lemma}`,
    );
  }
  await reader.waitForFunction(() => {
    const root = document.getElementById("voka-drawer")?.shadowRoot;
    const button = root?.querySelector<HTMLButtonElement>('[data-slot="review-button"]');
    const dueSummary = root?.querySelector('[data-slot="due-summary"]')?.textContent ?? "";
    return !!button && !button.hidden && /本页没有今日到期的词|Nothing due today/i.test(dueSummary);
  }, { timeout: 30000 });
  await reader.evaluate(() =>
    (document.getElementById("voka-drawer")!.shadowRoot!.querySelector('[data-slot="review-button"]') as HTMLButtonElement).click(),
  );
  await reader.waitForFunction(() => {
    const text = document.getElementById("voka-drawer")?.shadowRoot?.querySelector<HTMLElement>(".drawer-review-message")?.textContent ?? "";
    return text === "本页没有今日到期的词，可以点词卡练习" ||
      text === "Nothing on this page is due today. You can practice any word from its card.";
  }, { timeout: 30000 });
  const emptyReviewMessage = await reader.$eval(
    "#voka-drawer",
    (host) => host.shadowRoot!.querySelector<HTMLElement>(".drawer-review-message")?.textContent,
  );
  assert(
    emptyReviewMessage === "本页没有今日到期的词，可以点词卡练习" ||
      emptyReviewMessage === "Nothing on this page is due today. You can practice any word from its card.",
    `Review button showed an unexpected empty-due message: ${emptyReviewMessage}`,
  );

  const scannedInput = await reader.$("#file-input");
  assert(scannedInput, "reader file input missing before scanned PDF check");
  await scannedInput.uploadFile(imagePdfPath);
  await reader.waitForFunction(
    () => document.querySelector<HTMLElement>("#pdf-placeholder")?.textContent?.includes("没有可识别的文字层") ||
      document.querySelector<HTMLElement>("#pdf-placeholder")?.textContent?.includes("no recognizable text layer"),
    { timeout: 30000 },
  );
  const unsupported = await reader.evaluate(() => ({
    message: document.querySelector("#pdf-placeholder")?.textContent ?? "",
    readerHidden: (document.querySelector("#pdf-reader") as HTMLElement).hidden,
    controlsHidden: (document.querySelector("#pdf-controls") as HTMLElement).hidden,
  }));
  assert.equal(unsupported.readerHidden, true, "image-only PDF should not show the reader");
  assert.equal(unsupported.controlsHidden, true, "image-only PDF should hide PDF controls");
  assert(/此 PDF 没有可识别的文字层，暂不支持|This PDF has no recognizable text layer and isn't supported\./.test(unsupported.message));

  const nonExtensionRequests = readerRequests.filter((url) => !url.startsWith("chrome-extension://"));
  assert.deepEqual(nonExtensionRequests, [], "PDF reader must not make any non-extension network request");
  console.log(JSON.stringify({
    port: PORT,
    testDeck: TEST_DECK,
    dueWord: dueEntry.lemma,
    practiceWord: practiceEntry.lemma,
    splitAcrossTextNodes: highlightState.dueWordSplitAcrossNodes,
    savedSource: source,
    savedPageThreeSource: pageThreeSource,
    savedPosition,
    checks: [
      "three-page generated text PDF renders through the local PDF.js worker",
      "target highlight and due underline ranges belong to the PDF text layers",
      "hover tooltip and full card work, and the saved sentence spans split text nodes",
      "Anki source uses the PDF title and page 2 for a page 2 word",
      "a top-of-page-3 word uses page 3 in its source while page 2 is current",
      "previous/next page navigation works",
      "SHA-256 page and normalized offset restore after reopening (T-24b)",
      "the future-review practice word shows no ratings and leaves review id and scheduling unchanged",
      "drawer due filter lists four words and Review submits Again, Hard, Good, and Easy once each",
      "Review button shows the no-due practice message after all four reviews",
      "generated image-only PDF shows the file-level unsupported message",
      "the reader page makes no non-extension network requests",
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
  if (deckWasAbsent && deckCreateAttempted) await cleanupTestDeck();
  await rm(cacheRoot, { recursive: true, force: true });
  console.log("CLEANUP OK");
}

if (testError) throw testError;
