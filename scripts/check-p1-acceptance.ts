import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import puppeteer from "puppeteer";
import { checkConnection, rpc } from "../src/background/gateway";
import {
  CORE_FIELDS,
  DEFAULT_TARGET,
  lookup,
  vokaMeta,
} from "../src/background/import";
import { createData } from "../src/data";
import { normalizeKey } from "../src/key";
import { answerHtml, css, questionHtml } from "../src/data/template";
import { submitReview } from "../src/background/review";

const PORT = 8766;
const TEST_DECK = "VOKA Test::P1";
const config = { port: PORT, apiKey: "" };
const call = (method: string, params = {}, write = false) =>
  rpc(config, method, params, { sideEffecting: write }) as Promise<any>;
const quote = (value: string) =>
  '"' + value.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const testIds = ["T-12", "T-12a", "T-13", "T-14", "T-15", "T-16", "T-17", "T-18"];
const stateReadMethods = new Set([
  "notes.search",
  "notes.getMany",
  "cards.search",
  "cards.getMany",
  "scheduling.getDue",
]);
const testResults: {
  id: string;
  result: "PASS" | "FAIL";
  expected: string;
  actual: unknown;
}[] = [];
type Browser = Awaited<ReturnType<typeof puppeteer.launch>>;
type Page = Awaited<ReturnType<Browser["newPage"]>>;
const env: Record<string, unknown> = {
  port: PORT,
  testDeck: TEST_DECK,
  noteType: DEFAULT_TARGET.noteType,
};
let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
let page: Page | undefined;
let worker: any;
let base = "";
let fixtureHtml = "";
let serverStarted = false;
let deckWasAbsent = false;
let deckCreated = false;
let setupError: unknown;
let cleanupError: unknown;
let testWords: any[] = [];
let noteIds: string[] = [];
let cardIds: string[] = [];
let overdueFinding: Record<string, unknown> = {
  confirmed: false,
  attempts: [],
  note: "Not attempted yet",
};
let pageStateRequests: { total: number; methods: string[] } | undefined;
let fixtureServer: ReturnType<typeof createServer>;

const dataPacks = [
  "cefrj",
  "octanove",
  "oewn",
  "readings",
  "oewn-readings",
  "morphology",
  "gloss-zh",
  "gloss-leveled",
];

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function compact(value: unknown) {
  return JSON.stringify(value);
}

async function check(
  id: string,
  expected: string,
  run: () => Promise<unknown>,
) {
  try {
    const actual = await run();
    testResults.push({ id, result: "PASS", expected, actual });
    console.log(`[PASS] ${id}: ${compact(actual)}`);
  } catch (error) {
    const actual = messageOf(error);
    testResults.push({ id, result: "FAIL", expected, actual });
    console.error(`[FAIL] ${id}: ${actual}`);
  }
}

async function state(cardId: string) {
  return call("scheduling.get", { cardId });
}

async function due(cardId: string) {
  return call("scheduling.getDue", { cardId });
}

async function latestReviewId(cardId: string) {
  return (await call("reviews.getLatestId", { cardIds: [cardId] })).id;
}

async function answer(cardId: string, rating: string) {
  const prediction = await call("scheduling.predict", { cardId });
  assert(
    prediction.answers.some((option: any) => option.rating === rating),
    `Anki did not offer ${rating} for ${cardId}`,
  );
  const result = await call(
    "scheduling.answer",
    {
      cardId,
      rating,
      stateToken: prediction.stateToken,
      elapsedMs: 250,
    },
    true,
  );
  return result.scheduling ?? state(cardId);
}

async function setDue(cardId: string, days: string) {
  const result = await call(
    "scheduling.setDueDate",
    { cardIds: [cardId], days },
    true,
  );
  const item = result.items?.[0];
  if (!item || item.error)
    throw new Error(
      `scheduling.setDueDate(${JSON.stringify(days)}) failed: ${compact(item?.error ?? result)}`,
    );
  return item.result;
}

async function graduateToReview(cardId: string) {
  const scheduled = await answer(cardId, "easy");
  assert.equal(
    scheduled.type,
    "review",
    `Expected ${cardId} to graduate to Review, got ${scheduled.type}`,
  );
  return scheduled;
}

async function findUnusedEntries(entries: any[], count: number) {
  const unused: any[] = [];
  for (let start = 0; start < entries.length && unused.length < count; start += 100) {
    const batch = entries.slice(start, start + 100);
    const matches = await lookup(
      call,
      DEFAULT_TARGET,
      batch.map((entry) => normalizeKey(entry.lemma)),
    );
    for (const entry of batch) {
      if (matches.get(normalizeKey(entry.lemma))?.length === 0)
        unused.push(entry);
      if (unused.length === count) break;
    }
  }
  assert.equal(unused.length, count, `need ${count} unused B1 test words`);
  return unused;
}

async function searchTestNotes() {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const result = await call("notes.search", {
      query: `note:${quote(DEFAULT_TARGET.noteType)} deck:${quote(TEST_DECK)}`,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    ids.push(...result.ids.map(String));
    cursor = result.nextCursor ?? undefined;
  } while (cursor);
  return ids;
}

async function tryDueDate(cardId: string, days: string) {
  try {
    const response = await call(
      "scheduling.setDueDate",
      { cardIds: [cardId], days },
      true,
    );
    const item = response.items?.[0];
    if (item?.error)
      return { days, ok: false, error: item.error };
    return { days, ok: !!item?.result, result: item?.result };
  } catch (error) {
    return {
      days,
      ok: false,
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: messageOf(error),
        code: (error as { code?: unknown })?.code,
      },
    };
  }
}

async function prepareOverdueFinding(cardId: string, apiDescription: any) {
  const dueDateMethod = apiDescription.schema?.["x-methods"]?.["scheduling.setDueDate"];
  const daysSchema = apiDescription.schema?.$defs?.scheduling_setDueDate_Params?.properties?.days;
  assert(dueDateMethod, "api.describe did not describe scheduling.setDueDate");
  assert(daysSchema, "api.describe did not describe scheduling.setDueDate.days");
  assert.equal(dueDateMethod.effect, "write");
  assert.match(dueDateMethod.summary, /native days\/range syntax/i);
  assert.equal(daysSchema.type, "string");

  await graduateToReview(cardId);
  await setDue(cardId, "10");
  const prediction = await call("scheduling.predict", { cardId });
  assert(prediction.answers.some((option: any) => option.rating === "good"));
  await call(
    "scheduling.answer",
    {
      cardId,
      rating: "good",
      stateToken: prediction.stateToken,
      elapsedMs: 250,
    },
    true,
  );

  const attempts: any[] = [];
  let confirmed = false;
  for (const days of ["-1", "-2--1"]) {
    const attempt = await tryDueDate(cardId, days);
    if (attempt.ok) {
      const [eligibility, scheduling] = await Promise.all([due(cardId), state(cardId)]);
      Object.assign(attempt, { dueNow: eligibility.dueNow, scheduling });
      if (eligibility.dueNow === true) {
        confirmed = true;
        attempts.push(attempt);
        break;
      }
    }
    attempts.push(attempt);
  }
  await setDue(cardId, "10");
  overdueFinding = {
    confirmed,
    attempts,
    apiDescribe: {
      summary: dueDateMethod.summary,
      daysSchema,
    },
    note: confirmed
      ? "A negative native day value produced a dueNow card; it was reset to ten days for T-15 practice setup."
      : "No documented negative day/range form produced a confirmed overdue card; the card was reset to ten days and the acceptance run continued.",
  };
  console.log(`[INFO] OVERDUE FINDING: ${compact(overdueFinding)}`);
}

async function waitForLearningDue(cardId: string) {
  const deadline = Date.now() + 120_000;
  let last: any;
  while (Date.now() < deadline) {
    last = await due(cardId);
    if (last.dueNow === true) return last;
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
  }
  throw new Error(
    `Learning card did not become due within 120 seconds: ${compact({ eligibility: last, scheduling: await state(cardId) })}`,
  );
}

async function installFetchMonitor(workerContext: any) {
  await workerContext.evaluate(() => {
    const monitor = { count: 0, methods: [] as string[], blocked: [] as string[] };
    const originalFetch = globalThis.fetch.bind(globalThis);
    (globalThis as any).__p1FetchMonitor = monitor;
    globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
      const request = args[0];
      const rawUrl = typeof request === "string" ? request : request.url;
      const url = new URL(rawUrl);
      if (url.hostname === "127.0.0.1" && url.pathname === "/api/v1") {
        if (url.port === "8765" || url.port !== "8766") {
          monitor.blocked.push(url.href);
          throw new Error(`Blocked non-test Anki endpoint: ${url.href}`);
        }
        monitor.count++;
        try {
          const body = args[1]?.body;
          const payload = typeof body === "string" ? JSON.parse(body) : undefined;
          monitor.methods.push(typeof payload?.method === "string" ? payload.method : "unknown");
        } catch {
          monitor.methods.push("unknown");
        }
      }
      return originalFetch(...args);
    };
  });
}

async function monitorSnapshot() {
  return worker!.evaluate(() => {
    const monitor = (globalThis as any).__p1FetchMonitor;
    return monitor
      ? { total: monitor.count as number, methods: [...monitor.methods] as string[], blocked: [...monitor.blocked] as string[] }
      : undefined;
  });
}

function visibleHighlightWords(layer: string) {
  return page!.evaluate((name) => {
    const ranges = [...(CSS.highlights.get(name) ?? [])];
    return ranges.map((range) => range.toString());
  }, layer);
}

function keyAt(index: number) {
  return normalizeKey(testWords[index].lemma);
}

async function drawerState() {
  return page!.evaluate(() => {
    const root = document.getElementById("voka-drawer")?.shadowRoot;
    const summary = root?.querySelector('[data-slot="due-summary"]');
    const dueFilter = root?.querySelector('[data-filter="due"]');
    const allFilter = root?.querySelector('[data-filter="all"]');
    return {
      summary: summary?.textContent ?? "",
      dueFilter: dueFilter?.textContent ?? "",
      allFilter: allFilter?.textContent ?? "",
      listKeys: [...(root?.querySelectorAll(".drawer-list button") ?? [])].map(
        (button) => (button as HTMLElement).dataset.key ?? "",
      ),
    };
  });
}

function countFromLabel(value: string) {
  if (/Nothing due today|No due words|本页没有今日到期的词/.test(value)) return 0;
  const matches = [...value.matchAll(/\d+/g)];
  return matches.length ? Number(matches[matches.length - 1][0]) : 0;
}

async function openDrawerAndDueFilter() {
  await page!.waitForFunction(
    () => {
      const root = document.getElementById("voka-drawer")?.shadowRoot;
      return !!root?.querySelector(".drawer-body") &&
        !!root.querySelector(".drawer-toggle") &&
        !!root.querySelector('[data-filter="due"]');
    },
    { timeout: 30000 },
  );
  const drawerBodyHidden = await page!.evaluate(
    () =>
      (document
        .getElementById("voka-drawer")!
        .shadowRoot!.querySelector(".drawer-body") as HTMLElement).hidden,
  );
  if (drawerBodyHidden) {
    await page!.evaluate(() =>
      (document
        .getElementById("voka-drawer")!
        .shadowRoot!.querySelector(".drawer-toggle") as HTMLButtonElement).click(),
    );
    await page!.waitForFunction(
      () =>
        !(document
          .getElementById("voka-drawer")
          ?.shadowRoot?.querySelector(".drawer-body") as HTMLElement | null)?.hidden,
      { timeout: 30000 },
    );
  }
  await page!.evaluate(() => {
    const root = document.getElementById("voka-drawer")!.shadowRoot!;
    (root.querySelector('[data-filter="due"]') as HTMLButtonElement).click();
  });
}

async function openReviewFromSummary() {
  await page!.evaluate(() => {
    const root = document.getElementById("voka-drawer")!.shadowRoot!;
    (root.querySelector('[data-slot="due-summary"]') as HTMLButtonElement).click();
  });
  await page!.waitForFunction(
    () => !!document.getElementById("voka-drawer")?.shadowRoot?.querySelector("#voka-review-question"),
    { timeout: 30000 },
  );
}

async function waitForReviewWord(word: string) {
  await page!.waitForFunction(
    (expected) =>
      document
        .getElementById("voka-drawer")
        ?.shadowRoot?.querySelector("#voka-review-ui h3")
        ?.textContent?.startsWith(expected) === true,
    { timeout: 30000 },
    word,
  );
}

async function currentReviewHeading() {
  return page!.evaluate(
    () =>
      document
        .getElementById("voka-drawer")
        ?.shadowRoot?.querySelector("#voka-review-ui h3")?.textContent ?? "",
  );
}

async function waitForReviewHeadingChange(previous: string) {
  await page!.waitForFunction(
    (heading) => {
      const current =
        document
          .getElementById("voka-drawer")
          ?.shadowRoot?.querySelector("#voka-review-ui h3")?.textContent ?? "";
      return current !== "" && current !== heading;
    },
    { timeout: 30000 },
    previous,
  );
}

async function waitForReviewFinished() {
  await page!.waitForFunction(
    () =>
      /You finished today's due words|本页今日到期的词复习完了/.test(
        document
          .getElementById("voka-drawer")
          ?.shadowRoot?.querySelector("#voka-review-ui h3")?.textContent ?? "",
      ),
    { timeout: 30000 },
  );
}

async function revealCurrentAnswer() {
  await page!.evaluate(() => {
    const root = document.getElementById("voka-drawer")!.shadowRoot!;
    const view = root.querySelector("#voka-review-ui")!;
    const button = view.querySelector(".review-actions button") as HTMLButtonElement | null;
    if (!button) throw new Error("review front has no Show answer button");
    button.click();
  });
  await page!.waitForFunction(
    () => !!document.getElementById("voka-drawer")?.shadowRoot?.querySelector("#voka-review-answer"),
    { timeout: 30000 },
  );
  await page!.waitForFunction(
    () => !!document.getElementById("voka-drawer")?.shadowRoot?.querySelector("[data-review-rating]"),
    { timeout: 30000 },
  );
}

async function loadPage(options: { visibleWords?: number[]; revealLearning?: boolean } = {}) {
  await page!.goto(base, { waitUntil: "domcontentloaded" });
  await page!.evaluate(
    ({ visibleWords, revealLearning }) => {
      for (let index = 0; index < 8; index++) {
        const line = document.getElementById(`p1-line-${index}`) as HTMLElement;
        const shouldShow = visibleWords
          ? visibleWords.includes(index)
          : true;
        line.style.display = shouldShow ? "" : "none";
        if (index === 1) line.hidden = !revealLearning;
      }
    },
    options,
  );
  const tabId = await worker!.evaluate(
    async (url) =>
      (await chrome.tabs.query({})).find((tab) => tab.url?.startsWith(url))!.id!,
    base,
  );
  await worker!.evaluate(
    async (id) =>
      chrome.scripting.executeScript({
        target: { tabId: id },
        files: ["content.js"],
      }),
    tabId,
  );
  await page!.waitForFunction(
    () =>
      !!document
        .getElementById("voka-drawer")
        ?.shadowRoot?.querySelector('[data-slot="due-summary"]'),
    { timeout: 30000 },
  );
}

async function setPageVisibleWords(indices: number[], revealLearning = false) {
  await page!.evaluate(
    ({ visibleWords, showLearning }) => {
      for (let index = 0; index < 8; index++) {
        const line = document.getElementById(`p1-line-${index}`) as HTMLElement;
        line.style.display = visibleWords.includes(index) ? "" : "none";
        if (index === 1) line.hidden = !showLearning;
      }
      document.dispatchEvent(new Event("voka-refresh"));
    },
    { visibleWords: indices, showLearning: revealLearning },
  );
}

async function countSummaryDue() {
  const text = (await drawerState()).summary;
  return countFromLabel(text);
}

async function waitForSummaryCount(count: number) {
  await page!.waitForFunction(
    (expected) => {
      const summary = document
        .getElementById("voka-drawer")
        ?.shadowRoot?.querySelector('[data-slot="due-summary"]') as HTMLElement | null;
      if (!summary || summary.hidden) return false;
      const text = summary.textContent ?? "";
      if (expected === 0)
        return /Nothing due today|本页没有今日到期的词/.test(text);
      const explicit = /(?:Due today|今日到期)\s*(\d+)|(\d+)\s*(?:due today|今日到期)/i.exec(text);
      if (explicit) return Number(explicit[1] ?? explicit[2]) === expected;
      const first = /\d+/.exec(text);
      return first ? Number(first[0]) === expected : false;
    },
    { timeout: 30000 },
    count,
  );
}

async function ensureTypeExists() {
  const types = await call("noteTypes.list");
  assert(
    types.some((type: any) => type.name === DEFAULT_TARGET.noteType),
    `the real note type ${DEFAULT_TARGET.noteType} is missing from the isolated test instance`,
  );
  const type = await call("noteTypes.get", {
    noteType: { name: DEFAULT_TARGET.noteType },
  });
  assert.deepEqual(
    type.fields.map((field: any) => field.name),
    CORE_FIELDS,
    "the installed VOKA note type must have the P0 core fields",
  );
}

async function setup() {
  const connection = await checkConnection(config);
  assert.equal(connection, "ok", "8766 AnkiConnect must be ready");
  const [apiDescription, collection, decks] = await Promise.all([
    call("api.describe"),
    call("collection.get"),
    call("decks.list"),
  ]);
  env.ankiVersion = apiDescription.ankiVersion;
  env.ankiConnectApiMajor = apiDescription.apiMajor;
  env.scheduler = collection.scheduler;
  env.node = process.version;
  assert.equal(apiDescription.apiMajor, 1);
  assert.equal(collection.scheduler, "sm2", "expected isolated default scheduler SM-2");
  await ensureTypeExists();

  deckWasAbsent = !decks.some((deck: any) => deck.name === TEST_DECK);
  assert(deckWasAbsent, `${TEST_DECK} already exists; refusing to touch it`);
  const packs = await Promise.all(
    dataPacks.map(async (name) =>
      JSON.parse(await readFile(resolve(`public/data/${name}.json`), "utf8")),
    ),
  );
  const data = createData(packs);
  const candidates = data.pack.entries.filter(
    (entry: any) => /^[a-z]{3,18}$/.test(entry.lemma) && entry.level === "B1",
  );
  testWords = await findUnusedEntries(candidates, 8);

  const fixtureTemplate = await readFile(
    resolve("scripts/fixtures/p1-acceptance.html"),
    "utf8",
  );
  fixtureHtml = testWords.reduce(
    (html, entry, index) =>
      html.replaceAll(`__WORD_${index}__`, escapeHtml(entry.lemma)),
    fixtureTemplate,
  );
  fixtureServer = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(fixtureHtml);
  });

  await call("decks.create", { name: TEST_DECK }, true);
  deckCreated = true;
  const notes = await Promise.all(
    testWords.map(async (entry, index) => {
      const fields = Object.fromEntries(CORE_FIELDS.map((field) => [field, ""]));
      const escaped = {
        ...entry,
        Reading: escapeHtml(entry.Reading),
        GlossNative: escapeHtml(`P1_SYNTHETIC_NATIVE_GLOSS_${index}`),
        GlossTarget: escapeHtml(`P1_SYNTHETIC_TARGET_GLOSS_${index}`),
      };
      Object.assign(fields, {
        Key: normalizeKey(entry.lemma),
        Word: escapeHtml(entry.lemma),
        Variants: escapeHtml(entry.Variants ?? ""),
        Reading: escaped.Reading,
        GlossNative: escaped.GlossNative,
        GlossTarget: escaped.GlossTarget,
        Context1: escapeHtml(`Synthetic saved context for ${entry.lemma}.`),
        ManualStatus: index === 3 ? "known" : "",
        VokaMeta: await vokaMeta(escaped),
      });
      return {
        noteType: { name: DEFAULT_TARGET.noteType },
        deck: { name: TEST_DECK },
        tags: ["voka", "voka::level::B1"],
        fields,
      };
    }),
  );
  const validation = await call("notes.validateMany", { notes });
  assert.equal(validation.items.length, notes.length);
  assert(
    validation.items.every((item: any) => item.result?.valid === true),
    `note validation failed: ${compact(validation.items)}`,
  );
  const creation = await call(
    "notes.createMany",
    { notes, atomic: false },
    true,
  );
  noteIds = creation.items.flatMap((item: any) =>
    item.result?.noteId ? [String(item.result.noteId)] : [],
  );
  assert(
    creation.items.length === notes.length &&
      creation.items.every((item: any) => item.result?.noteId && !item.error),
    `note creation failed: ${compact(creation.items)}`,
  );
  const noteResults = await call("notes.getMany", { ids: noteIds });
  cardIds = noteResults.items.map((item: any) => {
    assert(!item.error, `note read failed: ${compact(item.error)}`);
    assert.equal(item.result.cardIds.length, 1);
    return String(item.result.cardIds[0]);
  });

  await graduateToReview(cardIds[0]);
  await setDue(cardIds[0], "0");

  const learningState = await answer(cardIds[1], "again");
  assert(
    ["learning", "learn"].includes(learningState.type),
    `expected a Learning card after Again, got ${learningState.type}`,
  );

  await graduateToReview(cardIds[2]);
  let matureState = await state(cardIds[2]);
  for (let step = 0; matureState.intervalDays < 21 && step < 24; step++)
    matureState = await answer(cardIds[2], "easy");
  assert(
    matureState.type === "review" && matureState.intervalDays >= 21,
    `expected mature Review interval >= 21 days, got ${compact(matureState)}`,
  );
  await setDue(cardIds[2], "0");

  await graduateToReview(cardIds[3]);
  await setDue(cardIds[3], "0");

  await graduateToReview(cardIds[6]);
  await setDue(cardIds[6], "10");
  await graduateToReview(cardIds[7]);
  await prepareOverdueFinding(cardIds[7], apiDescription);
  await setDue(cardIds[7], "0");
  const beforeSuspend = await due(cardIds[7]);
  assert.equal(beforeSuspend.dueNow, true, "suspended card must otherwise be due");
  const suspended = await call(
    "cards.setSuspended",
    { ids: [cardIds[7]], suspended: true },
    true,
  );
  assert(
    !suspended.items?.[0]?.error,
    `could not suspend test card: ${compact(suspended.items?.[0]?.error)}`,
  );
  assert.equal((await due(cardIds[7])).dueNow, false);

  await waitForLearningDue(cardIds[1]);
  const preparedStates = await Promise.all(cardIds.map(state));
  assert.equal(preparedStates[0].type, "review");
  assert.equal(preparedStates[1].type, "learning");
  assert.equal(preparedStates[2].type, "review");
  assert(preparedStates[2].intervalDays >= 21);
  assert.equal(preparedStates[3].type, "review");
  assert.equal(preparedStates[4].type, "new");
  assert.equal(preparedStates[5].type, "new");
  assert.equal(preparedStates[6].type, "review");
  assert.equal(preparedStates[7].queue, "suspended");
  assert.equal((await due(cardIds[0])).dueNow, true);
  assert.equal((await due(cardIds[1])).dueNow, true);
  assert.equal((await due(cardIds[2])).dueNow, true);
  assert.equal((await due(cardIds[3])).dueNow, true);
  assert.equal((await due(cardIds[6])).dueNow, false);
  assert.equal((await due(cardIds[7])).dueNow, false);

  await new Promise<void>((resolveListen, rejectListen) => {
    fixtureServer.once("error", rejectListen);
    fixtureServer.listen(0, "127.0.0.1", () => {
      fixtureServer.off("error", rejectListen);
      resolveListen();
    });
  });
  serverStarted = true;
  base = `http://127.0.0.1:${(fixtureServer.address() as any).port}`;

  browser = await puppeteer.launch({
    headless: false,
    enableExtensions: [resolve("dist")],
    args: ["--no-first-run"],
  });
  env.chromeForTesting = await browser.version();
  const serviceWorkerTarget = await browser.waitForTarget(
    (target) => target.type() === "service_worker",
  );
  worker = (await serviceWorkerTarget.worker()) as any;
  await worker!.evaluate(() =>
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
  await installFetchMonitor(worker);
  page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 950 });
}

async function runChecks() {
  const visibleReviewIndices = [0, 2, 3];
  const visibleReviewWords = visibleReviewIndices.map((index) => testWords[index].lemma);
  const expectedReviewKeys = visibleReviewIndices.map(keyAt).sort();

  await loadPage();
  await waitForSummaryCount(3);
  await page!.waitForFunction(
    (expected) =>
      (CSS.highlights.get("voka-due")?.size ?? 0) === expected,
    { timeout: 30000 },
    2,
  );
  const monitor = await monitorSnapshot();
  assert(monitor, "failed to instrument service-worker Anki HTTP requests");
  const measured = monitor.methods.filter((method) => stateReadMethods.has(method));
  pageStateRequests = { total: measured.length, methods: measured };
  env.blockedAnkiEndpoints = monitor.blocked;

  await check(
    "T-12",
    "Three due Review words are listed; New, future Review, and suspended cards are excluded from due marking and the due filter.",
    async () => {
      const dueWords = await visibleHighlightWords("voka-due");
      assert.deepEqual([...dueWords].sort(), [testWords[0].lemma, testWords[2].lemma].sort());
      assert(!dueWords.includes(testWords[4].lemma));
      assert(!dueWords.includes(testWords[5].lemma));
      assert(!dueWords.includes(testWords[6].lemma));
      assert(!dueWords.includes(testWords[7].lemma));
      await openDrawerAndDueFilter();
      const drawer = await drawerState();
      assert.deepEqual([...drawer.listKeys].sort(), expectedReviewKeys);
      assert.equal(countFromLabel(drawer.dueFilter), 3);
      const suspendedSearch = await call("cards.search", {
        query: `note:${quote(DEFAULT_TARGET.noteType)} deck:${quote(TEST_DECK)} is:suspended`,
        limit: 100,
      });
      assert(suspendedSearch.ids.map(String).includes(cardIds[7]));
      assert.equal((await due(cardIds[7])).dueNow, false);
      assert.equal(pageStateRequests?.total, measured.length);
      assert.equal(monitor.blocked.length, 0, "browser attempted a non-8766 Anki request");
      return {
        dueUnderlines: dueWords,
        dueFilterKeys: drawer.listKeys,
        dueFilterCount: countFromLabel(drawer.dueFilter),
        suspendedIsNotDueMarkedOrListed: true,
        pageStateHttpRequests: pageStateRequests,
      };
    },
  );

  await check(
    "T-12a",
    "The mature due Review card is underlined; the known due card has no highlight but remains in the count and due list.",
    async () => {
      const dueWords = await visibleHighlightWords("voka-due");
      const allLayers = await page!.evaluate(() =>
        Object.fromEntries(
          ["voka-target", "voka-learning", "voka-unknown", "voka-weak", "voka-due"].map(
            (name) => [
              name,
              [...(CSS.highlights.get(name) ?? [])].map((range) => range.toString()),
            ],
          ),
        ),
      ) as Record<string, string[]>;
      assert(dueWords.includes(testWords[2].lemma), "mature card is missing its due underline");
      assert(
        ["voka-target", "voka-learning", "voka-unknown", "voka-weak"].every(
          (layer) => !allLayers[layer].includes(testWords[2].lemma),
        ),
        "mature due card unexpectedly has a color highlight",
      );
      assert(
        Object.values(allLayers).every((words) => !words.includes(testWords[3].lemma)),
        "known due word must have no page highlight",
      );
      await openDrawerAndDueFilter();
      const drawer = await drawerState();
      assert.equal(countFromLabel(drawer.dueFilter), 3);
      assert(drawer.listKeys.includes(keyAt(3)), "known due word is missing from the due filter");
      assert.equal(await countSummaryDue(), 3);
      return {
        matureIntervalDays: (await state(cardIds[2])).intervalDays,
        matureUnderlined: dueWords.includes(testWords[2].lemma),
        knownHidden: !Object.values(allLayers).some((words) => words.includes(testWords[3].lemma)),
        knownCountedAndListed: drawer.listKeys.includes(keyAt(3)),
        dueSummary: drawer.summary,
      };
    },
  );

  await check(
    "T-13",
    "Review front shows rendered question and local page sentence without either gloss; the gloss appears only after Show answer.",
    async () => {
      await loadPage();
      await waitForSummaryCount(3);
      await openReviewFromSummary();
      await waitForReviewWord(testWords[0].lemma);
      const front = await page!.evaluate(() => {
        const root = document.getElementById("voka-drawer")!.shadowRoot!;
        const view = root.querySelector("#voka-review-ui")!;
        const sentence = view.querySelector(".review-sentence");
        return {
          question: root.querySelector("#voka-review-question")?.textContent ?? "",
          answerVisible: !!root.querySelector("#voka-review-answer"),
          sentence: sentence?.textContent ?? "",
          sentenceBold: !!sentence?.querySelector("b"),
          ratings: view.querySelectorAll("[data-review-rating]").length,
        };
      });
      assert(!front.answerVisible);
      assert(front.sentence.includes(testWords[0].lemma));
      assert(front.sentenceBold);
      assert.equal(front.ratings, 0);
      assert(!front.question.includes("P1_SYNTHETIC_NATIVE_GLOSS_0"));
      assert(!front.question.includes("P1_SYNTHETIC_TARGET_GLOSS_0"));

      const prediction = await call("scheduling.predict", { cardId: cardIds[0] });
      await revealCurrentAnswer();
      const back = await page!.evaluate(() => {
        const root = document.getElementById("voka-drawer")!.shadowRoot!;
        const view = root.querySelector("#voka-review-ui")!;
        return {
          answer: root.querySelector("#voka-review-answer")?.textContent ?? "",
          ratings: [...view.querySelectorAll("[data-review-rating]")].map(
            (button) => (button as HTMLElement).dataset.reviewRating,
          ),
          labels: [...view.querySelectorAll("[data-review-rating]")].map(
            (button) => button.textContent ?? "",
          ),
        };
      });
      assert(back.answer.includes("P1_SYNTHETIC_NATIVE_GLOSS_0"));
      assert(back.answer.includes("P1_SYNTHETIC_TARGET_GLOSS_0"));
      assert.equal(back.ratings.length, prediction.answers.length);
      prediction.answers.forEach((option: any, index: number) => {
        if (option.interval != null)
          assert(back.labels[index].includes(option.label));
      });
      return {
        front,
        afterReveal: {
          answerContainsGloss: true,
          ratings: back.ratings,
          labels: back.labels,
        },
      };
    },
  );

  await check(
    "T-14",
    "The three due Review cards and due Learning card receive Again, Hard, Good, Easy in queue order, each creating one review record and changing scheduling state.",
    async () => {
      await loadPage({ revealLearning: true });
      await waitForSummaryCount(4);
      await openReviewFromSummary();
      const reviewIndices = [0, 1, 2, 3];
      const ratings = ["again", "hard", "good", "easy"];
      const before = Object.fromEntries(
        await Promise.all(
          reviewIndices.map(async (index) => [
            index,
            { latest: await latestReviewId(cardIds[index]), state: await state(cardIds[index]) },
          ] as const),
        ),
      ) as Record<number, { latest: unknown; state: any }>;
      const observations: any[] = [];
      const issues: string[] = [];
      const seen = new Set<number>();
      const conflictRetries: { word: string; noReviewWasWritten: boolean }[] = [];
      for (let offset = 0; offset < ratings.length; offset++) {
        try {
          const heading = await currentReviewHeading();
          if (/You finished today's due words|本页今日到期的词复习完了/.test(heading)) {
            issues.push(`review queue finished after ${offset} of four cards`);
            break;
          }
          const index = reviewIndices.find((candidate) =>
            heading.startsWith(testWords[candidate].lemma),
          );
          if (index === undefined) {
            issues.push(`unexpected review queue heading: ${heading}`);
            break;
          }
          if (seen.has(index)) {
            issues.push(`review queue repeated ${testWords[index].lemma}: ${heading}`);
            break;
          }
          seen.add(index);
          assert.equal(
            (await due(cardIds[index])).dueNow,
            true,
            `${testWords[index].lemma} stopped being due before its rating`,
          );
          const hasRatings = await page!.evaluate(
            () => !!document.getElementById("voka-drawer")?.shadowRoot?.querySelector("[data-review-rating]"),
          );
          if (!hasRatings) await revealCurrentAnswer();
          const button = await page!.evaluate((rating) => {
            const root = document.getElementById("voka-drawer")!.shadowRoot!;
            const target = root.querySelector(`[data-review-rating="${rating}"]`) as HTMLButtonElement | null;
            if (!target) throw new Error(`missing ${rating} button`);
            target.click();
            return true;
          }, ratings[offset]);
          assert(button);
          await page!.waitForFunction(
            (previous) => {
              const root = document.getElementById("voka-drawer")?.shadowRoot;
              const current = root?.querySelector("#voka-review-ui h3")?.textContent ?? "";
              const status = root?.querySelector("#voka-review-status")?.textContent ?? "";
              return current !== previous ||
                /Card state changed\. Please rate again\.|卡片状态已变化，请重新评分/.test(status);
            },
            { timeout: 30000 },
            heading,
          );
          let nextHeading = await currentReviewHeading();
          const reviewStatus = await page!.evaluate(
            () => document.getElementById("voka-drawer")?.shadowRoot?.querySelector("#voka-review-status")?.textContent ?? "",
          );
          if (nextHeading === heading && /Card state changed\. Please rate again\.|卡片状态已变化，请重新评分/.test(reviewStatus)) {
            const rejectedRecords = await call("reviews.list", {
              cardIds: [cardIds[index]],
              afterId: before[index].latest,
              limit: 20,
            });
            assert.equal(rejectedRecords.items.length, 0, "a state conflict must not write a review before the user retries");
            await page!.waitForFunction(
              (rating) => {
                const button = document
                  .getElementById("voka-drawer")
                  ?.shadowRoot?.querySelector(`[data-review-rating="${rating}"]`) as HTMLButtonElement | null;
                return !!button && !button.disabled;
              },
              { timeout: 30000 },
              ratings[offset],
            );
            await page!.evaluate((rating) => {
              const button = document
                .getElementById("voka-drawer")!
                .shadowRoot!.querySelector(`[data-review-rating="${rating}"]`) as HTMLButtonElement;
              button.click();
            }, ratings[offset]);
            conflictRetries.push({ word: testWords[index].lemma, noReviewWasWritten: true });
            await waitForReviewHeadingChange(heading);
            nextHeading = await currentReviewHeading();
          }
          if (offset < ratings.length - 1 && /You finished today's due words|本页今日到期的词复习完了/.test(nextHeading))
            issues.push(`review queue finished after ${offset + 1} of four cards`);
          if (offset === ratings.length - 1)
            await waitForReviewFinished();

          const records = await call("reviews.list", {
            cardIds: [cardIds[index]],
            afterId: before[index].latest,
            limit: 20,
          });
          assert.equal(records.items.length, 1, `expected one review for ${testWords[index].lemma}`);
          assert.equal(records.items[0].rating, ratings[offset]);
          const after = await state(cardIds[index]);
          assert.notDeepEqual(after, before[index].state);
          observations.push({
            word: testWords[index].lemma,
            stateBefore: before[index].state,
            rating: ratings[offset],
            review: records.items[0],
            stateAfter: after,
          });
        } catch (error) {
          const heading = await currentReviewHeading();
          const failedIndex = reviewIndices.find((candidate) =>
            heading.startsWith(testWords[candidate].lemma),
          );
          const diagnostic = failedIndex === undefined
            ? undefined
            : {
                word: testWords[failedIndex].lemma,
                due: await due(cardIds[failedIndex]),
                scheduling: await state(cardIds[failedIndex]),
                latestReviewId: await latestReviewId(cardIds[failedIndex]),
                status: await page!.evaluate(
                  () => document.getElementById("voka-drawer")?.shadowRoot?.querySelector("#voka-review-status")?.textContent ?? "",
                ),
                ratingButtons: await page!.evaluate(
                  () => [...(document.getElementById("voka-drawer")?.shadowRoot?.querySelectorAll("[data-review-rating]") ?? [])].map((button) => (button as HTMLElement).dataset.reviewRating),
                ),
              };
          issues.push(`${heading}: ${messageOf(error)} ${compact(diagnostic)}`);
          break;
        }
      }
      if (!seen.has(1)) issues.push(`Learning card ${testWords[1].lemma} was not in the review queue`);
      assert.equal(issues.length, 0, issues.join("; "));
      assert.equal(observations.length, 4);
      return { observations, conflictRetries };
    },
  );

  await check(
    "T-15",
    "After Anki directly grades the queued future Review card, the page reports it was already completed and does not create a second review.",
    async () => {
      await setDue(cardIds[6], "0");
      assert.equal((await due(cardIds[6])).dueNow, true);
      await loadPage({ visibleWords: [6] });
      await waitForSummaryCount(1);
      await openReviewFromSummary();
      await waitForReviewWord(testWords[6].lemma);
      await revealCurrentAnswer();
      const baseline = await latestReviewId(cardIds[6]);
      const beforeState = await state(cardIds[6]);
      const directState = await answer(cardIds[6], "good");
      await page!.evaluate(() => {
        const root = document.getElementById("voka-drawer")!.shadowRoot!;
        (root.querySelector('[data-review-rating="hard"]') as HTMLButtonElement).click();
      });
      await page!.waitForFunction(
        () =>
          /Already completed in Anki; skipping|已在 Anki 里完成，跳过/.test(
            document
              .getElementById("voka-drawer")
              ?.shadowRoot?.querySelector("#voka-review-status")?.textContent ?? "",
          ),
        { timeout: 30000 },
      );
      const records = await call("reviews.list", {
        cardIds: [cardIds[6]],
        afterId: baseline,
        limit: 20,
      });
      assert.equal(records.items.length, 1);
      assert.equal(records.items[0].rating, "good");
      assert.notDeepEqual(directState, beforeState);
      assert.notDeepEqual(await state(cardIds[6]), beforeState);
      return {
        directAnkiRating: records.items[0].rating,
        reviewRecordsAdded: records.items.length,
        status: "already completed in Anki; skipping",
      };
    },
  );

  await check(
    "T-16",
    "The timeout-after-forward wrapper confirms the accepted answer through review history and never forwards scheduling.answer twice.",
    async () => {
      const timeoutCardIndex = 2;
      await setDue(cardIds[timeoutCardIndex], "0");
      const beforeState = await state(cardIds[timeoutCardIndex]);
      assert.equal((await due(cardIds[timeoutCardIndex])).dueNow, true);
      const baseline = await latestReviewId(cardIds[timeoutCardIndex]);
      const prediction = await call("scheduling.predict", { cardId: cardIds[timeoutCardIndex] });
      let answerCalls = 0;
      const timeoutAfterForward = async (
        method: string,
        params: Record<string, unknown> = {},
      ) => {
        const result = await call(method, params, method === "scheduling.answer");
        if (method === "scheduling.answer") {
          answerCalls++;
          throw new Error("simulated response timeout after acceptance");
        }
        return result;
      };
      const confirmed = await submitReview(timeoutAfterForward, {
        cardId: cardIds[timeoutCardIndex],
        rating: "easy",
        stateToken: prediction.stateToken,
        elapsedMs: 250,
        latestReviewId: baseline,
      });
      assert.equal(confirmed.outcome, "confirmed");
      assert.equal(answerCalls, 1);
      const records = await call("reviews.list", {
        cardIds: [cardIds[timeoutCardIndex]],
        afterId: baseline,
        limit: 20,
      });
      assert.equal(records.items.length, 1);
      assert.equal(records.items[0].rating, "easy");
      assert.notDeepEqual(await state(cardIds[timeoutCardIndex]), beforeState);
      return {
        outcome: confirmed.outcome,
        answerCalls,
        rating: records.items[0].rating,
        reviewRecordsAdded: records.items.length,
      };
    },
  );

  await check(
    "T-17",
    "New cards and a future Review card allow front → Show answer → Next only; no rating controls appear and reviews.getLatestId/scheduling.get stay unchanged.",
    async () => {
      let stage = "restore future Review card";
      try {
        await setDue(cardIds[6], "10");
        assert.equal((await due(cardIds[6])).dueNow, false);
        stage = "load page and wait for no due cards";
        await loadPage({ visibleWords: [4, 5, 6] });
        await waitForSummaryCount(0);
        const practiceIndices = [4, 5, 6];
        const before = await Promise.all(
          practiceIndices.map(async (index) => ({
            latest: await latestReviewId(cardIds[index]),
            scheduling: await state(cardIds[index]),
          })),
        );
        const observations: any[] = [];
      const issues: any[] = [];
        for (const index of practiceIndices) {
        try {
          stage = `click ${testWords[index].lemma}`;
          await page!.locator(`#p1-word-${index}`).click();
          stage = `wait for ${testWords[index].lemma} card`;
          await page!.waitForFunction(
            () => {
              const root = document.getElementById("voka-drawer")?.shadowRoot;
              const card = root?.querySelector("#voka-card") as HTMLElement | null;
              const button = root?.querySelector("#voka-practice-word") as HTMLButtonElement | null;
              return !!card && !card.hidden && !!button && !button.disabled;
            },
            { timeout: 30000 },
          );
          await page!.evaluate(() =>
            (document.getElementById("voka-drawer")!.shadowRoot!.querySelector("#voka-practice-word") as HTMLButtonElement).click(),
          );
          stage = `wait for ${testWords[index].lemma} practice front`;
          await page!.waitForFunction(
            () =>
              !!document
                .getElementById("voka-drawer")
                ?.shadowRoot?.querySelector('[data-slot="review-ui"] .practice-label'),
            { timeout: 30000 },
          );
          await page!.waitForFunction(
            () => {
              const question = document
                .getElementById("voka-drawer")
                ?.shadowRoot?.querySelector("#voka-review-question");
              return !!question?.textContent?.trim();
            },
            { timeout: 30000 },
          );
          const front = await page!.evaluate(() => {
            const view = document
              .getElementById("voka-drawer")!
              .shadowRoot!.querySelector('[data-slot="review-ui"]')!;
            return {
              label: view.querySelector(".practice-label")?.textContent ?? "",
              question: view.querySelector("#voka-review-question")?.textContent ?? "",
              sentence: view.querySelector(".review-sentence")?.textContent ?? "",
              ratings: view.querySelectorAll("[data-review-rating]").length,
            };
          });
          assert.match(front.label, /Practice|练习/);
          assert(front.question.length > 0);
          assert(front.sentence.includes(testWords[index].lemma));
          assert.equal(front.ratings, 0);
          stage = `reveal ${testWords[index].lemma} answer`;
          await page!.evaluate(() =>
            (document
              .getElementById("voka-drawer")!
              .shadowRoot!.querySelector('[data-practice-action="show-answer"]') as HTMLButtonElement).click(),
          );
          await page!.waitForFunction(
            () =>
              !!document
                .getElementById("voka-drawer")
                ?.shadowRoot?.querySelector('[data-slot="review-ui"] #voka-review-answer'),
            { timeout: 30000 },
          );
          const back = await page!.evaluate(() => {
            const view = document
              .getElementById("voka-drawer")!
              .shadowRoot!.querySelector('[data-slot="review-ui"]')!;
            return {
              answer: view.querySelector("#voka-review-answer")?.textContent ?? "",
              label: view.querySelector(".practice-label")?.textContent ?? "",
              ratings: view.querySelectorAll("[data-review-rating]").length,
              next: view.querySelector('[data-practice-action="next"]')?.textContent ?? "",
            };
          });
          assert(back.answer.length > 0);
          assert.match(back.label, /Practice|练习/);
          assert.equal(back.ratings, 0);
          assert.match(back.next, /Next|下一个/);
          stage = `advance ${testWords[index].lemma} practice`;
          await page!.evaluate(() =>
            (document
              .getElementById("voka-drawer")!
              .shadowRoot!.querySelector('[data-practice-action="next"]') as HTMLButtonElement).click(),
          );
          await page!.waitForFunction(
            () =>
              (document
                .getElementById("voka-drawer")
                ?.shadowRoot?.querySelector('[data-slot="review-ui"]') as HTMLElement | null)
                ?.hidden,
            { timeout: 30000 },
          );
          observations.push({ word: testWords[index].lemma, label: front.label, ratingButtons: 0 });
        } catch (error) {
          const snapshot = await page!.evaluate((wordIndex) => {
            const root = document.getElementById("voka-drawer")?.shadowRoot;
            const card = root?.querySelector("#voka-card") as HTMLElement | null;
            const practice = root?.querySelector("#voka-practice-word") as HTMLButtonElement | null;
            const highlights = Object.fromEntries(
              ["voka-target", "voka-learning", "voka-unknown", "voka-weak", "voka-due"].map(
                (name) => [name, [...(CSS.highlights.get(name) ?? [])].map((range) => range.toString())],
              ),
            );
            return {
              word: document.querySelector(`#p1-word-${wordIndex}`)?.textContent,
              visible: !!document.querySelector(`#p1-word-${wordIndex}`) &&
                getComputedStyle(document.querySelector(`#p1-line-${wordIndex}`)!).display !== "none",
              cardHidden: card?.hidden,
              cardText: card?.textContent,
              practiceButton: practice ? { text: practice.textContent, disabled: practice.disabled } : undefined,
              highlights,
            };
          }, index);
          issues.push({ word: testWords[index].lemma, stage, error: messageOf(error), snapshot });
          if (index < practiceIndices[practiceIndices.length - 1]) {
            await loadPage();
            await waitForSummaryCount(0);
          }
        }
      }
        stage = "compare before and after scheduling snapshots";
      const after = await Promise.all(
        practiceIndices.map(async (index) => ({
          latest: await latestReviewId(cardIds[index]),
          scheduling: await state(cardIds[index]),
        })),
      );
      assert.deepEqual(after, before);
      assert.equal(issues.length, 0, compact(issues));
      return { cards: observations, stateUnchanged: true };
      } catch (error) {
        throw new Error(`${stage}: ${messageOf(error)}`, { cause: error });
      }
    },
  );

  await check(
    "T-18",
    "After grading a newly due mature card, its underline disappears, the due summary falls from one to zero, and due/all word-list counts recalculate.",
    async () => {
      let stage = "set mature card due";
      try {
      await setDue(cardIds[2], "0");
      assert.equal((await due(cardIds[2])).dueNow, true);
      stage = "load page and verify mature due mark";
      await loadPage({ visibleWords: [2] });
      await waitForSummaryCount(1);
      const beforeUnderline = await visibleHighlightWords("voka-due");
      assert(beforeUnderline.includes(testWords[2].lemma));
      await page!.evaluate(() => {
        const root = document.getElementById("voka-drawer")!.shadowRoot!;
        const body = root.querySelector(".drawer-body") as HTMLElement;
        if (body.hidden)
          (root.querySelector(".drawer-toggle") as HTMLButtonElement).click();
        (root.querySelector('[data-filter="all"]') as HTMLButtonElement).click();
      });
      const allBeforeReview = await drawerState();
      const baseline = await latestReviewId(cardIds[2]);
      stage = "open mature card review";
      await openReviewFromSummary();
      await waitForReviewWord(testWords[2].lemma);
      await revealCurrentAnswer();
      await page!.evaluate(() => {
        const root = document.getElementById("voka-drawer")!.shadowRoot!;
        (root.querySelector('[data-review-rating="good"]') as HTMLButtonElement).click();
      });
      await waitForReviewFinished();
      stage = "wait for due summary to clear";
      await waitForSummaryCount(0);
      const afterUnderline = await visibleHighlightWords("voka-due");
      assert(!afterUnderline.includes(testWords[2].lemma));
      const records = await call("reviews.list", {
        cardIds: [cardIds[2]],
        afterId: baseline,
        limit: 20,
      });
      assert.equal(records.items.length, 1);
      assert.equal(records.items[0].rating, "good");
      assert.equal((await due(cardIds[2])).dueNow, false);

      stage = "return to list";
      const returnedToList = await page!.evaluate(() => {
        const root = document.getElementById("voka-drawer")!.shadowRoot!;
        const returnButton = [...root.querySelectorAll("#voka-review-ui button")].find(
          (button) => /Return to list|返回列表/.test(button.textContent ?? ""),
        ) as HTMLButtonElement | undefined;
        if (!returnButton) throw new Error("review completion has no Return to list button");
        returnButton.click();
        return {
          reviewHidden: (root.querySelector("#voka-review-ui") as HTMLElement).hidden,
          dueFilterPresent: !!root.querySelector('[data-filter="due"]'),
        };
      });
      if (!returnedToList.reviewHidden)
        throw new Error(`review UI remained visible after clicking Return to list: ${compact(returnedToList)}`);
      stage = `wait for returned list filters (immediate state ${compact(returnedToList)})`;
      await page!.waitForFunction(
        () => {
          const root = document.getElementById("voka-drawer")?.shadowRoot;
          return !!root?.querySelector('[data-filter="due"]') &&
            !!root?.querySelector('[data-filter="all"]');
        },
        { timeout: 30000 },
      );
      stage = "open due filter";
      await openDrawerAndDueFilter();
      const dueDrawer = await drawerState();
      assert.equal(countFromLabel(dueDrawer.dueFilter), 0);
      assert.equal(dueDrawer.listKeys.length, 0);
      stage = "open all filter";
      await page!.waitForFunction(
        () => !!document.getElementById("voka-drawer")?.shadowRoot?.querySelector('[data-filter="all"]'),
        { timeout: 30000 },
      );
      await page!.evaluate(() => {
        const root = document.getElementById("voka-drawer")!.shadowRoot!;
        (root.querySelector('[data-filter="all"]') as HTMLButtonElement).click();
      });
      const drawer = await drawerState();
      assert.equal(
        countFromLabel(drawer.allFilter),
        countFromLabel(allBeforeReview.allFilter),
        `all-filter count changed unexpectedly: ${compact({ before: allBeforeReview, after: drawer })}`,
      );
      assert.deepEqual(drawer.listKeys, allBeforeReview.listKeys);
      return {
        dueBefore: 1,
        dueAfter: countFromLabel(dueDrawer.dueFilter),
        underlineRemoved: !afterUnderline.includes(testWords[2].lemma),
        dueFilterCount: countFromLabel(dueDrawer.dueFilter),
        dueFilterRows: dueDrawer.listKeys.length,
        allFilterCount: countFromLabel(drawer.allFilter),
        allFilterKeys: drawer.listKeys,
        allFilterStableAcrossReview: true,
      };
      } catch (error) {
        throw new Error(`${stage}: ${messageOf(error)}`, { cause: error });
      }
    },
  );
}

async function cleanup() {
  await browser?.close();
  if (serverStarted && fixtureServer.listening)
    await new Promise<void>((resolveClose, rejectClose) =>
      fixtureServer.close((error) => (error ? rejectClose(error) : resolveClose())),
    );
  if (!deckCreated) {
    console.log("CLEANUP OK (no test data created)");
    return;
  }
  const decks = await call("decks.list");
  if (!decks.some((deck: any) => deck.name === TEST_DECK)) {
    console.log("CLEANUP OK (test deck already absent)");
    return;
  }
  const existing = await searchTestNotes();
  const owned = new Set(noteIds);
  const unexpected = existing.filter((id) => !owned.has(id));
  if (unexpected.length)
    throw new Error(`refusing to delete notes not created by this run: ${unexpected.join(",")}`);
  for (let start = 0; start < noteIds.length; start += 100) {
    const ids = noteIds.slice(start, start + 100);
    if (ids.length) await call("notes.delete", { ids }, true);
  }
  const remaining = await searchTestNotes();
  assert.equal(remaining.length, 0, `test notes remain after cleanup: ${remaining.join(",")}`);
  await call(
    "decks.delete",
    { decks: [{ name: TEST_DECK }], deleteCards: true },
    true,
  );
  const [notesAfter, decksAfter] = await Promise.all([
    searchTestNotes(),
    call("decks.list"),
  ]);
  assert.equal(notesAfter.length, 0);
  assert(!decksAfter.some((deck: any) => deck.name === TEST_DECK));
  console.log("CLEANUP OK");
}

async function main() {
  try {
    assert.equal(PORT, 8766, "this acceptance script must use the isolated test instance");
    await setup();
    await runChecks();
  } catch (error) {
    setupError = error;
    console.error(`[FAIL] SETUP/RUN: ${messageOf(error)}`);
  } finally {
    try {
      await cleanup();
    } catch (error) {
      cleanupError = error;
      console.error(`[FAIL] CLEANUP: ${messageOf(error)}`);
    }
    const completed = new Set(testResults.map((result) => result.id));
    for (const id of testIds) {
      if (completed.has(id)) continue;
      const actual = `NOT RUN: ${messageOf(setupError ?? new Error("an earlier check stopped the run"))}`;
      testResults.push({
        id,
        result: "FAIL",
        expected: "Acceptance assertion block executes and prints a result.",
        actual,
      });
      console.error(`[FAIL] ${id}: ${actual}`);
    }
    const summary = {
      environment: env,
      overdueFinding,
      pageStateRequests,
      results: testResults,
      cleanup: cleanupError ? { ok: false, error: messageOf(cleanupError) } : { ok: true },
    };
    console.log(JSON.stringify(summary, null, 2));
    if (
      setupError ||
      cleanupError ||
      testResults.some((result) => result.result !== "PASS")
    )
      process.exitCode = 1;
  }
}

await main();
