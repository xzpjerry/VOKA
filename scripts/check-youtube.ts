import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

const PORT = 8766;
const TEST_DECK = "VOKA Test::96";
const config = { port: PORT, apiKey: "" };
const call = (method: string, params = {}, write = false) =>
  rpc(config, method, params, { sideEffecting: write }) as Promise<any>;
const quote = (value: string) =>
  '"' + value.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
const emptyJson3 = JSON.stringify({ events: [] });

assert.equal(
  await checkConnection(config),
  "ok",
  "the isolated AnkiConnect instance on 8766 must be ready",
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
const candidates = data.pack.entries.filter(
  (entry) => entry.level === "B1" && /^[a-z]{3,18}$/.test(entry.lemma),
);
const fixtureHtml = await readFile(
  resolve("scripts/fixtures/youtube.html"),
  "utf8",
);

let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
let testExtensionDir: string | undefined;
let testTempDir: string | undefined;
let testDeckWasAbsent = false;
let deckCreateAttempted = false;
let createdNoteIds: string[] = [];
let testWord = "";
let dueWord = "";
let dueCardId = "";
let baselineReviewId: unknown;

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

async function createFixtureNote() {
  const [types, decks] = await Promise.all([
    call("noteTypes.list"),
    call("decks.list"),
  ]);
  testDeckWasAbsent = !decks.some((deck: any) => deck.name === TEST_DECK);
  assert(testDeckWasAbsent, `${TEST_DECK} already exists; refusing to touch it`);
  if (!types.some((type: any) => type.name === DEFAULT_TARGET.noteType)) {
    await call(
      "noteTypes.create",
      {
        name: DEFAULT_TARGET.noteType,
        fields: CORE_FIELDS.map((name) => ({ name })),
        templates: [{ name: "词卡", questionHtml, answerHtml }],
        css,
        sortField: "Word",
      },
      true,
    );
  }
  const type = await call("noteTypes.get", {
    noteType: { name: DEFAULT_TARGET.noteType },
  });
  assert.deepEqual(
    type.fields.map((field: any) => field.name),
    CORE_FIELDS,
    "the isolated test instance must have the VOKA core fields",
  );

  deckCreateAttempted = true;
  await call("decks.create", { name: TEST_DECK }, true);
  const available: typeof candidates = [];
  for (let start = 0; start < candidates.length && available.length < 2; start += 100) {
    const batch = candidates.slice(start, start + 100);
    const matches = await lookup(
      call,
      DEFAULT_TARGET,
      batch.map((entry) => normalizeKey(entry.lemma)),
    );
    for (const entry of batch) {
      if (matches.get(normalizeKey(entry.lemma))?.length === 0)
        available.push(entry);
      if (available.length === 2) break;
    }
  }
  assert.equal(available.length, 2, "need two unused B1 words for the YouTube fixture");
  testWord = available[0].lemma;
  dueWord = available[1].lemma;
  const notes = await Promise.all(
    available.map(async (entry) => {
      const escaped = {
        ...entry,
        Reading: escapeHtml(entry.Reading),
        GlossNative: escapeHtml(entry.GlossNative),
        GlossTarget: escapeHtml(entry.GlossTarget),
      };
      const fields = Object.fromEntries(CORE_FIELDS.map((field) => [field, ""]));
      Object.assign(fields, {
        Key: normalizeKey(entry.lemma),
        Word: escapeHtml(entry.lemma),
        Variants: escapeHtml(entry.Variants ?? ""),
        Reading: escaped.Reading,
        GlossNative: escaped.GlossNative,
        GlossTarget: escaped.GlossTarget,
        VokaMeta: await vokaMeta(escaped),
      });
      return {
        noteType: { name: DEFAULT_TARGET.noteType },
        deck: { name: TEST_DECK },
        tags: ["voka", `voka::level::${entry.level}`],
        fields,
      };
    }),
  );
  const validation = await call("notes.validateMany", { notes });
  assert.equal(validation.items.length, notes.length);
  assert(
    validation.items.every((item: any) => item.result?.valid === true),
    `test note validation failed: ${JSON.stringify(validation.items)}`,
  );
  const creation = await call(
    "notes.createMany",
    { notes, atomic: false },
    true,
  );
  assert(
    creation.items.every((item: any) => item.result?.noteId && !item.error),
    `test note creation failed: ${JSON.stringify(creation.items)}`,
  );
  createdNoteIds = creation.items.map((item: any) => String(item.result.noteId));
  const noteResults = await call("notes.getMany", { ids: createdNoteIds });
  const cardIds = noteResults.items.map((item: any) => {
    assert(!item.error, `test note read failed: ${JSON.stringify(item.error)}`);
    assert.equal(item.result.cardIds.length, 1);
    return String(item.result.cardIds[0]);
  });
  dueCardId = cardIds[1];
  const prediction = await call("scheduling.predict", { cardId: dueCardId });
  assert(prediction.answers.some((answer: any) => answer.rating === "easy"));
  const graduated = await call(
    "scheduling.answer",
    {
      cardId: dueCardId,
      rating: "easy",
      stateToken: prediction.stateToken,
      elapsedMs: 250,
    },
    true,
  );
  const state = graduated.scheduling ?? (await call("scheduling.get", { cardId: dueCardId }));
  assert.equal(state.type, "review", "the due fixture word must be a Review card");
  await call("scheduling.setDueDate", { cardIds: [dueCardId], days: "0" }, true);
  assert.equal(
    (await call("scheduling.getDue", { cardId: dueCardId })).dueNow,
    true,
    "the fixture word must be due today",
  );
  baselineReviewId = (await call("reviews.getLatestId", { cardIds: [dueCardId] })).id;
}

async function loadExtensionAndFindWorker() {
  testTempDir = await mkdtemp(join(tmpdir(), "voka-youtube-check-"));
  testExtensionDir = join(testTempDir, "extension");
  await cp(resolve("dist"), testExtensionDir, { recursive: true });
  const manifestPath = join(testExtensionDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.host_permissions = [
    ...new Set([...(manifest.host_permissions ?? []), "https://www.youtube.com/*"]),
  ];
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  // The extension's install flow opens options before this script can set the
  // 8766 test port; keep that temporary page inert so it cannot touch 8765.
  await writeFile(
    join(testExtensionDir, "options.html"),
    "<!doctype html><html><head><title>VOKA test options</title></head><body></body></html>",
  );

  browser = await puppeteer.launch({
    headless: false,
    enableExtensions: [testExtensionDir],
    args: ["--no-first-run"],
  });
  const workerTarget = await browser.waitForTarget(
    (target) => target.type() === "service_worker",
  );
  const worker = await workerTarget.worker();
  assert(worker, "extension service worker did not start");
  const extensionId = new URL(workerTarget.url()).host;
  await worker.evaluate(() =>
    chrome.storage.local.set({
      port: 8766,
      apiKey: "",
      targetLevel: "B1",
      nativeLanguage: "zh",
      glossLanguage: "native",
      showAdvanced: false,
      hoverScope: "highlighted",
      storeFullUrl: false,
      youtubeDiagnostics: false,
      youtubeAutoResume: true,
      siteScope: "activeTab",
    }),
  );

  const granted = await worker.evaluate(() =>
    chrome.permissions.contains({ origins: ["https://www.youtube.com/*"] }),
  );
  assert.equal(granted, true, "the browser check must grant www.youtube.com access");
  return worker;
}

async function runBrowserCheck() {
  const worker = await loadExtensionAndFindWorker();
  assert.equal(
    await checkConnection(config),
    "ok",
    "8766 must remain reachable during the browser check",
  );
  const page = await browser!.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const blockedOutsideMachine: string[] = [];
  const refetchUrls: string[] = [];
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    let url: URL;
    try {
      url = new URL(request.url());
    } catch {
      blockedOutsideMachine.push(request.url());
      void request.abort("blockedbyclient");
      return;
    }
    if (url.hostname !== "www.youtube.com") {
      blockedOutsideMachine.push(request.url());
      void request.abort("blockedbyclient");
      return;
    }
    if (url.pathname === "/watch") {
      void request.respond({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: fixtureHtml,
      });
      return;
    }
    if (url.pathname.includes("/api/timedtext")) {
      const lang = url.searchParams.get("lang") ?? "";
      const videoId = url.searchParams.get("v") ?? "fixture1";
      const hasPlayerToken =
        url.searchParams.has("pot") && url.searchParams.get("c") === "WEB";
      if (
        videoId === "fixture2" &&
        lang.startsWith("en") &&
        url.searchParams.get("fmt") === "json3"
      )
        refetchUrls.push(request.url());
      let body = emptyJson3;
      if (hasPlayerToken) {
        if (videoId === "fixture1") {
          body = JSON.stringify({
            events: [
              {
                tStartMs: 1000,
                dDurationMs: 4000,
                segs: [{ utf8: `The ${testWord} is ready.` }],
              },
              {
                tStartMs: 12000,
                dDurationMs: 5000,
                segs: [{ utf8: `A ${dueWord} shines in bright light.` }],
              },
              {
                tStartMs: 35000,
                dDurationMs: 5000,
                segs: [{ utf8: `Another ${testWord} waits nearby.` }],
              },
              {
                tStartMs: 65000,
                dDurationMs: 5000,
                segs: [{ utf8: `The ${testWord} returns before sunset.` }],
              },
            ],
          });
        } else {
          const caption =
            videoId === "fixture2" && lang.startsWith("en")
              ? `Auto ${testWord} is ready.`
              : videoId === "fixture2" && lang === "fr"
                ? "French fixture caption."
                : "Other fixture caption.";
          body = JSON.stringify({
            events: [
              {
                tStartMs: 0,
                dDurationMs: 4000,
                segs: [{ utf8: caption }],
              },
            ],
          });
        }
      }
      void request.respond({
        status: 200,
        contentType: "application/json; charset=utf-8",
        body,
      });
      return;
    }
    if (url.pathname === "/favicon.ico") {
      void request.respond({ status: 204, body: "" });
      return;
    }
    void request.abort("blockedbyclient");
  });

  await page.goto("https://www.youtube.com/watch?v=fixture1");
  await page.bringToFront();
  const tabId = await worker.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((tab) => tab.url?.startsWith("https://www.youtube.com/watch?v=fixture1"))?.id;
  });
  assert.equal(typeof tabId, "number", "fixture tab was not visible to the extension");
  await worker.evaluate(
    async (id) =>
      chrome.scripting.executeScript({
        target: { tabId: id },
        files: ["content.js"],
      }),
    tabId!,
  );

  const lineText = () =>
    page.$eval("#voka-subtitle .voka-subtitle-text", (element) => element.textContent ?? "");
  await page.waitForFunction(
    (word) =>
      document.querySelector("#voka-subtitle .voka-subtitle-text")?.textContent?.includes(word),
    {},
    testWord,
  );
  assert.match(await lineText(), new RegExp(testWord));
  await page.waitForFunction(
    (word) =>
      [...(CSS.highlights.get("voka-target") ?? [])].some((range) =>
        range.toString().includes(word),
      ),
    {},
    testWord,
  );
  const hiddenNativeCaptions = await page.$eval(
    ".ytp-caption-window-container",
    (element) => getComputedStyle(element).opacity,
  );
  assert.equal(hiddenNativeCaptions, "0", "native captions were not hidden with opacity");
  assert.equal(
    await page.$eval("#voka-subtitle .voka-youtube-diagnostic", (element) => (element as HTMLElement).hidden),
    true,
    "diagnostics should start hidden",
  );

  await worker.evaluate(() => chrome.storage.local.set({ youtubeDiagnostics: true }));
  await page.waitForFunction(() => {
    const diagnostic = document.querySelector("#voka-subtitle .voka-youtube-diagnostic");
    return diagnostic && !(diagnostic as HTMLElement).hidden && /(?:方法|Method) 1/.test(diagnostic.textContent ?? "");
  });
  let diagnosticText = await page.$eval(
    "#voka-subtitle .voka-youtube-diagnostic",
    (element) => element.textContent ?? "",
  );
  assert(!diagnosticText.includes(testWord));
  assert(!diagnosticText.includes("The "));
  assert(!diagnosticText.includes("fixture1"));
  assert.match(diagnosticText, /4 条|4 cues/);
  await page.evaluate(() => {
    const video = document.querySelector("video")!;
    Object.defineProperty(video, "currentTime", { configurable: true, writable: true, value: 5 });
    video.dispatchEvent(new Event("timeupdate"));
  });
  await page.waitForFunction(
    () => document.querySelector("#voka-subtitle")?.hasAttribute("hidden"),
  );
  await page.evaluate(() => {
    const video = document.querySelector("video")!;
    Object.defineProperty(video, "currentTime", { configurable: true, writable: true, value: 1 });
    video.dispatchEvent(new Event("timeupdate"));
  });
  await page.waitForFunction(
    (word) => document.querySelector("#voka-subtitle .voka-subtitle-text")?.textContent?.includes(word),
    {},
    testWord,
  );
  await page.waitForFunction(
    (word) =>
      [...(CSS.highlights.get("voka-target") ?? [])].some((range) =>
        range.toString().includes(word),
      ),
    {},
    testWord,
  );

  // T-20: stay paused across the subtitle line, tooltip, and full card, then
  // resume only after leaving every VOKA zone.
  await page.evaluate(() => (document.querySelector("video") as HTMLVideoElement).play());
  await page.waitForFunction(() => !(document.querySelector("video") as HTMLVideoElement).paused);
  let lineBox = await (await page.$("#voka-subtitle"))!.boundingBox();
  assert(lineBox, "subtitle line is not visible for the hover check");
  await page.mouse.move(lineBox.x + lineBox.width / 2, lineBox.y + lineBox.height / 2);
  await page.waitForFunction(() => (document.querySelector("video") as HTMLVideoElement).paused);
  await page.waitForFunction((word) => {
    const subtitle = document.querySelector("#voka-subtitle");
    return [...(CSS.highlights.get("voka-target") ?? [])].some(
      (item) => item.toString().includes(word) && subtitle?.contains(item.startContainer),
    );
  }, {}, testWord);
  const wordRect = await page.evaluate((word) => {
    const subtitle = document.querySelector("#voka-subtitle");
    const range = [...(CSS.highlights.get("voka-target") ?? [])].find(
      (item) => item.toString().includes(word) && subtitle?.contains(item.startContainer),
    );
    if (!range) return null;
    const rect = range.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }, testWord);
  assert(wordRect, "the fixture word is not highlighted in the subtitle line");
  await page.mouse.move(wordRect.x + wordRect.width / 2, wordRect.y + wordRect.height / 2);
  await page.waitForFunction((word) => {
    const tooltip = document.getElementById("voka-drawer")?.shadowRoot?.querySelector("[role=tooltip]") as HTMLElement | null;
    return !!tooltip && !tooltip.hidden && tooltip.textContent?.includes(word);
  }, {}, testWord);
  await page.mouse.click(wordRect.x + wordRect.width / 2, wordRect.y + wordRect.height / 2);
  await page.waitForFunction(() => {
    const card = document.getElementById("voka-drawer")?.shadowRoot?.querySelector("#voka-card") as HTMLElement | null;
    return !!card && !card.hidden;
  });
  assert.equal(
    await page.$eval("video", (video) => (video as HTMLVideoElement).paused),
    true,
    "opening the full card resumed the video",
  );
  const cardRect = await page.evaluate(() => {
    const card = document.getElementById("voka-drawer")?.shadowRoot?.querySelector("#voka-card");
    if (!card) return null;
    const rect = card.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  assert(cardRect, "full card is missing from the session Shadow DOM");
  await page.mouse.move(cardRect.x + Math.min(24, cardRect.width / 2), cardRect.y + 24);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(
    await page.$eval("video", (video) => (video as HTMLVideoElement).paused),
    true,
    "moving from the subtitle line to the full card resumed the video",
  );
  await page.mouse.move(10, 10);
  await page.waitForFunction(() => !(document.querySelector("video") as HTMLVideoElement).paused);

  // T-21: a user pause event while VOKA has paused playback prevents delayed
  // recovery when the pointer leaves the subtitle zones.
  await page.evaluate(() => (document.querySelector("video") as HTMLVideoElement).play());
  lineBox = await (await page.$("#voka-subtitle"))!.boundingBox();
  assert(lineBox, "subtitle line is not visible for the user-pause check");
  await page.mouse.move(lineBox.x + lineBox.width / 2, lineBox.y + lineBox.height / 2);
  await page.waitForFunction(() => (document.querySelector("video") as HTMLVideoElement).paused);
  const pauseBox = await (await page.$("#fake-player-pause"))!.boundingBox();
  assert(pauseBox, "fake player pause button is missing");
  await page.mouse.move(pauseBox.x + pauseBox.width / 2, pauseBox.y + pauseBox.height / 2);
  await page.mouse.click(pauseBox.x + pauseBox.width / 2, pauseBox.y + pauseBox.height / 2);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(
    await page.$eval("video", (video) => (video as HTMLVideoElement).paused),
    true,
    "a user pause during hover was undone after leaving the subtitle line",
  );
  await page.mouse.move(10, 10);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(
    await page.$eval("video", (video) => (video as HTMLVideoElement).paused),
    true,
    "the video resumed after the user paused it",
  );

  const testKey = normalizeKey(testWord);
  const dueKey = normalizeKey(dueWord);
  await page.evaluate(() => {
    const root = document.getElementById("voka-drawer")!.shadowRoot!;
    (root.querySelector(".drawer-toggle") as HTMLButtonElement).click();
    (root.querySelector('[data-filter="all"]') as HTMLButtonElement).click();
  });
  await page.waitForFunction(
    (wordKey, dueWordKey) => {
      const root = document.getElementById("voka-drawer")?.shadowRoot;
      const word = root?.querySelector(
        `.drawer-list button[data-key="${wordKey}"]`,
      );
      const due = root?.querySelector(
        `.drawer-list button[data-key="${dueWordKey}"]`,
      );
      return (
        word?.textContent?.includes("×3") &&
        word.querySelector(".drawer-word-time")?.textContent === "00:01" &&
        !!due
      );
    },
    {},
    testKey,
    dueKey,
  );
  const panelSnapshot = await page.evaluate(
    ({ wordKey, dueWordKey }) => {
      const root = document.getElementById("voka-drawer")!.shadowRoot!;
      return {
        word: root.querySelector(
          `.drawer-list button[data-key="${wordKey}"]`,
        )?.textContent,
        dueWord: root.querySelector(
          `.drawer-list button[data-key="${dueWordKey}"]`,
        )?.textContent,
        scope: root.querySelector(".drawer-scope-note")?.textContent,
        dueSummary: root.querySelector('[data-slot="due-summary"]')?.textContent,
      };
    },
    { wordKey: testKey, dueWordKey: dueKey },
  );
  assert.match(panelSnapshot.word ?? "", /×3/);
  assert.match(panelSnapshot.word ?? "", /00:01/);
  assert(panelSnapshot.dueWord, "the drawer must include words from a later cue");
  assert.match(panelSnapshot.scope ?? "", /整个视频的词汇|Whole video/);
  assert.match(panelSnapshot.dueSummary ?? "", /1/);
  assert(
    !(await lineText()).includes(dueWord),
    "the due word should be outside the current subtitle line",
  );

  await page.evaluate(() => {
    const video = document.querySelector("video")!;
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      writable: true,
      value: 80,
    });
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  await page.evaluate((key) => {
    const root = document.getElementById("voka-drawer")!.shadowRoot!;
    (
      root.querySelector(
        `.drawer-list button[data-key="${key}"] .drawer-word-time`,
      ) as HTMLSpanElement
    ).click();
  }, testKey);
  assert.equal(
    await page.$eval("video", (video) => (video as HTMLVideoElement).currentTime),
    1,
    "clicking the first-appearance time must seek the fake video",
  );
  await page.waitForFunction(() => {
    const card = document
      .getElementById("voka-drawer")
      ?.shadowRoot?.querySelector("#voka-card") as HTMLElement | null;
    const save = card?.querySelector("#voka-save-context") as HTMLButtonElement | null;
    return !!card && !card.hidden && !!save && !save.disabled;
  });
  const cardSentences = await page.$eval(
    "#voka-drawer",
    (host) =>
      [...host.shadowRoot!.querySelectorAll("#voka-card p")]
        .map((paragraph) => paragraph.textContent ?? "")
        .join(" "),
  );
  assert.match(cardSentences, new RegExp(`The ${testWord} is ready\\.`));
  assert.equal(
    await page.$eval("#voka-drawer", (host) =>
      !(host.shadowRoot!.querySelector("#voka-save-context") as HTMLButtonElement).disabled,
    ),
    true,
    "the transcript example must be available to save",
  );
  await page.evaluate(() => {
    const root = document.getElementById("voka-drawer")!.shadowRoot!;
    const save = root.querySelector("#voka-save-context") as HTMLButtonElement;
    save.click();
  });
  await page.waitForFunction(() => {
    const card = document.getElementById("voka-drawer")?.shadowRoot;
    return !!card?.querySelector('#voka-card [role="status"]')?.textContent?.trim();
  });
  const saveStatus = await page.$eval(
    "#voka-drawer",
    (host) => host.shadowRoot?.querySelector('#voka-card [role="status"]')?.textContent ?? "",
  );
  assert.match(saveStatus, /例句已保存|Context saved/);
  const savedNote = await call("notes.getMany", { ids: [createdNoteIds[0]] });
  const savedFields = savedNote.items[0]?.result?.fields ?? {};
  assert.equal(
    (savedFields.Context1 ?? "").replace(/<[^>]+>/g, ""),
    `The ${testWord} is ready.`,
  );
  assert.match(
    savedFields.Source1 ?? "",
    /youtube\.com · Fixture YouTube video · 00:01 · \d{4}-\d{2}-\d{2}/,
  );

  await page.evaluate(() => {
    const root = document.getElementById("voka-drawer")!.shadowRoot!;
    (root.querySelector("#voka-practice-word") as HTMLButtonElement).click();
  });
  await page.waitForFunction((word) => {
    const root = document.getElementById("voka-drawer")?.shadowRoot;
    return (
      root?.querySelector("#voka-review-ui h3")?.textContent === word &&
      root.querySelector("#voka-review-ui .review-sentence")?.textContent ===
        `The ${word} is ready.`
    );
  }, {}, testWord);
  await page.evaluate(() => {
    const root = document.getElementById("voka-drawer")!.shadowRoot!;
    (root.querySelector('[data-practice-action="show-answer"]') as HTMLButtonElement).click();
  });
  await page.waitForFunction(() =>
    !!document
      .getElementById("voka-drawer")
      ?.shadowRoot?.querySelector('[data-practice-action="next"]'),
  );
  await page.evaluate(() => {
    const root = document.getElementById("voka-drawer")!.shadowRoot!;
    (root.querySelector('[data-practice-action="next"]') as HTMLButtonElement).click();
  });
  await page.waitForFunction(() =>
    (document
      .getElementById("voka-drawer")
      ?.shadowRoot?.querySelector("#voka-review-ui") as HTMLElement | null)?.hidden,
  );

  await page.evaluate(() => {
    const root = document.getElementById("voka-drawer")!.shadowRoot!;
    (root.querySelector("#voka-card button") as HTMLButtonElement).click();
    (root.querySelector('[data-slot="review-button"]') as HTMLButtonElement).click();
  });
  await page.waitForFunction(
    (word) => {
      const root = document.getElementById("voka-drawer")?.shadowRoot;
      const heading = root?.querySelector("#voka-review-ui h3")?.textContent ?? "";
      const sentence =
        root?.querySelector("#voka-review-ui .review-sentence")?.textContent ?? "";
      return heading.startsWith(word) && sentence.includes(word);
    },
    {},
    dueWord,
  );
  await page.evaluate(() => {
    const root = document.getElementById("voka-drawer")!.shadowRoot!;
    const showAnswer = [...root.querySelectorAll("#voka-review-ui button")].find(
      (button) => /Show answer|显示答案/.test(button.textContent ?? ""),
    ) as HTMLButtonElement | undefined;
    showAnswer?.click();
  });
  await page.waitForFunction(() =>
    !!document
      .getElementById("voka-drawer")
      ?.shadowRoot?.querySelector('[data-review-rating="good"]'),
  );
  await page.evaluate(() => {
    const root = document.getElementById("voka-drawer")!.shadowRoot!;
    (root.querySelector('[data-review-rating="good"]') as HTMLButtonElement).click();
  });
  await page.waitForFunction(() => {
    const heading = document
      .getElementById("voka-drawer")
      ?.shadowRoot?.querySelector("#voka-review-ui h3")?.textContent ?? "";
    return /finished|完了/.test(heading.toLowerCase());
  });
  const reviewRecords = await call("reviews.list", {
    cardIds: [dueCardId],
    afterId: baselineReviewId,
    limit: 20,
  });
  assert.equal(
    reviewRecords.items.filter(
      (item: any) => String(item.cardId) === dueCardId && item.rating === "good",
    ).length,
    1,
    "the transcript due word must record one Good review",
  );
  assert.equal(reviewRecords.items.length, 1, "T-14 should add one review only");

  await page.evaluate(() => (window as any).__vokaSetVideo("fixture2"));
  await page.waitForFunction(() => {
    const diagnostic = document.querySelector("#voka-subtitle .voka-youtube-diagnostic");
    return /(?:方法|Method) 2/.test(diagnostic?.textContent ?? "");
  });
  assert.match(await lineText(), /Auto/);
  assert.equal(refetchUrls.length > 0, true, "the token-bearing English refetch was not used");
  const refetch = new URL(refetchUrls.at(-1)!);
  assert.equal(refetch.searchParams.get("pot"), "fixture-proof-token");
  assert.equal(refetch.searchParams.get("c"), "WEB");
  assert.equal(refetch.searchParams.get("lang"), "en-US");
  assert.equal(refetch.searchParams.get("kind"), "asr");
  assert.equal(refetch.searchParams.get("fmt"), "json3");
  assert.equal(refetch.searchParams.has("tlang"), false);
  assert.equal(refetch.searchParams.get("keep"), "fixture-value");
  diagnosticText = await page.$eval(
    "#voka-subtitle .voka-youtube-diagnostic",
    (element) => element.textContent ?? "",
  );
  assert(!diagnosticText.includes(testWord));
  assert(!diagnosticText.includes("Auto"));
  assert(!diagnosticText.includes("fixture2"));

  await page.click("#voka-subtitle button");
  await page.waitForFunction(() => !document.querySelector("#voka-subtitle"));
  assert.equal(
    await page.$eval(".ytp-caption-window-container", (element) => getComputedStyle(element).opacity),
    "1",
    "closing VOKA subtitles did not restore native captions",
  );

  for (const videoId of ["fixture3", "fixture4"]) {
    await page.evaluate((id) => (window as any).__vokaSetVideo(id), videoId);
    await page.waitForFunction(() => {
      const text = document.querySelector("#voka-subtitle .voka-subtitle-text")?.textContent ?? "";
      return text.includes("此视频没有可读取的英文字幕") || text.includes("No readable English subtitles");
    });
    const text = await lineText();
    assert.match(text, /此视频没有可读取的英文字幕|No readable English subtitles/);
    diagnosticText = await page.$eval(
      "#voka-subtitle .voka-youtube-diagnostic",
      (element) => element.textContent ?? "",
    );
    assert.match(diagnosticText, /(?:方法|Method) 4/);
    assert.match(diagnosticText, /0 条|0 cues/);
    assert(!diagnosticText.includes(testWord));
    assert(!diagnosticText.includes(videoId));
  }

  assert.equal(blockedOutsideMachine.length, 0, `blocked non-fixture requests: ${blockedOutsideMachine.join(", ")}`);
  console.log(
    JSON.stringify(
      {
        browser: await browser!.version(),
        ankiPort: PORT,
        testDeck: TEST_DECK,
        testWord,
        dueWord,
        checks: [
          "fixture1 human English captions use method 1 and highlight a test word from 8766",
          "the fixture1 drawer combines all cues, shows ×3 plus first appearance, scope and whole-video due count",
          "clicking a first-appearance time seeks; saving the first cue stores its YouTube title, time and date",
          "practice from a transcript word uses that first cue sentence and records no rating",
          "the due word from a later transcript cue reviews through the shared flow and records one Good review",
          "T-20 pauses across the subtitle word, tooltip, and full card, then resumes after all zones are left",
          "T-21 preserves a user pause and does not resume after leaving the subtitle line",
          "subtitle line follows video.currentTime and native captions hide with opacity",
          "diagnostics default off, then show method and cue count without cue text, ID, or title",
          "fixture2 automatic English captions use token-preserving method 2 after a wrong-language response",
          "closing VOKA subtitles restores native captions",
          "fixture3 other-language-only and fixture4 no-track pages show the no-English message",
          "SPA video changes reset the source and cue list",
          "all page requests were intercepted or aborted; no request left the machine",
        ],
      },
      null,
      2,
    ),
  );
}

try {
  await createFixtureNote();
  await runBrowserCheck();
} finally {
  await browser?.close();
  if (testTempDir) await rm(testTempDir, { recursive: true, force: true });
  if (testDeckWasAbsent && deckCreateAttempted) {
    const cleanupIds = await searchTestNotes();
    for (let start = 0; start < cleanupIds.length; start += 100)
      await call(
        "notes.delete",
        { ids: cleanupIds.slice(start, start + 100) },
        true,
      );
    assert.equal((await searchTestNotes()).length, 0, "YouTube test notes were not removed");
    await call(
      "decks.delete",
      { decks: [{ name: TEST_DECK }], deleteCards: true },
      true,
    );
    const decks = await call("decks.list");
    assert(
      !decks.some((deck: any) => deck.name === TEST_DECK),
      "YouTube test deck was not removed",
    );
    console.log("CLEANUP OK");
  }
}
