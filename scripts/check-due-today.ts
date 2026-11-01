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

const PORT = 8766;
const TEST_DECK = "VOKA Test::78";
const config = { port: PORT, apiKey: "" };
const call = (method: string, params = {}, write = false) =>
  rpc(config, method, params, { sideEffecting: write }) as Promise<any>;
const quote = (value: string) =>
  '"' + value.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
const escapeHtml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const wordId = (index: number) => `due-word-${index}`;
const isDueBadge = (value: string) => /Due today|今日到期/.test(value);

assert.equal(await checkConnection(config), "ok", "8766 AnkiConnect must be ready");
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
const typeName = DEFAULT_TARGET.noteType;
const candidateEntries = data.pack.entries.filter(
  (entry) => /^[a-z]{3,18}$/.test(entry.lemma) && entry.level === "B1",
);
const fixtureTemplate = await readFile(
  resolve("scripts/fixtures/due-today.html"),
  "utf8",
);
let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
let fixtureHtml = fixtureTemplate;
const server = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(fixtureHtml);
});
let deckWasAbsent = false;
let deckCreateAttempted = false;
let testWords: typeof candidateEntries = [];
let createdNoteIds: string[] = [];
let testFailed: unknown;

async function findUnusedEntries(count: number) {
  const unused: typeof candidateEntries = [];
  for (let start = 0; start < candidateEntries.length && unused.length < count; start += 100) {
    const batch = candidateEntries.slice(start, start + 100);
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

async function state(cardId: string) {
  return call("scheduling.get", { cardId });
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

async function graduateToReview(cardId: string) {
  let current = await answer(cardId, "easy");
  if (current.type !== "review")
    throw new Error(`Expected ${cardId} to graduate to Review; got ${current.type}`);
  return current;
}

async function setDue(cardId: string, days: "0" | "10") {
  await call("scheduling.setDueDate", { cardIds: [cardId], days }, true);
}

async function searchTestNotes() {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const result = await call("notes.search", {
      query: `note:${quote(typeName)} deck:${quote(TEST_DECK)}`,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    ids.push(...result.ids.map(String));
    cursor = result.nextCursor ?? undefined;
  } while (cursor);
  return ids;
}

try {
  const [types, decks] = await Promise.all([
    call("noteTypes.list"),
    call("decks.list"),
  ]);
  deckWasAbsent = !decks.some((deck: any) => deck.name === TEST_DECK);
  assert(deckWasAbsent, `${TEST_DECK} already exists; refusing to touch it`);
  const typeExists = types.some((type: any) => type.name === typeName);
  if (!typeExists) {
    await call(
      "noteTypes.create",
      {
        name: typeName,
        fields: CORE_FIELDS.map((name) => ({ name })),
        templates: [{ name: "词卡", questionHtml, answerHtml }],
        css,
        sortField: "Word",
      },
      true,
    );
  } else {
    const type = await call("noteTypes.get", {
      noteType: { name: typeName },
    });
    assert.deepEqual(
      type.fields.map((field: any) => field.name),
      CORE_FIELDS,
      "the installed VOKA note type must have the P0 core fields",
    );
  }
  deckCreateAttempted = true;
  await call("decks.create", { name: TEST_DECK }, true);

  testWords = await findUnusedEntries(7);
  const testNotes = await Promise.all(
    testWords.map(async (entry, index) => {
      const fields = Object.fromEntries(CORE_FIELDS.map((field) => [field, ""]));
      const escaped = {
        ...entry,
        Reading: escapeHtml(entry.Reading),
        GlossNative: escapeHtml(entry.GlossNative),
        GlossTarget: escapeHtml(entry.GlossTarget),
      };
      Object.assign(fields, {
        Key: normalizeKey(entry.lemma),
        Word: escapeHtml(entry.lemma),
        Variants: escapeHtml(entry.Variants ?? ""),
        Reading: escaped.Reading,
        GlossNative: escaped.GlossNative,
        GlossTarget: escaped.GlossTarget,
        ManualStatus: index === 3 ? "known" : "",
        VokaMeta: await vokaMeta(escaped),
      });
      return {
        noteType: { name: typeName },
        deck: { name: TEST_DECK },
        tags: ["voka", `voka::level::${entry.level}`],
        fields,
      };
    }),
  );
  const validation = await call("notes.validateMany", { notes: testNotes });
  assert.equal(validation.items.length, testNotes.length);
  assert(
    validation.items.every((item: any) => item.result?.valid === true),
    `note validation failed: ${JSON.stringify(validation.items)}`,
  );
  const creation = await call(
    "notes.createMany",
    { notes: testNotes, atomic: false },
    true,
  );
  assert(
    creation.items.every((item: any) => item.result?.noteId && !item.error),
    `note creation failed: ${JSON.stringify(creation.items)}`,
  );
  const keys = testWords.map((entry) => normalizeKey(entry.lemma));
  const idsByKey = await lookup(call, DEFAULT_TARGET, keys);
  assert(keys.every((key) => idsByKey.get(key)?.length === 1));
  createdNoteIds = keys.map((key) => idsByKey.get(key)![0]);
  const noteResults = await call("notes.getMany", { ids: createdNoteIds });
  const cardIds = noteResults.items.map((item: any) => {
    assert(!item.error, `note read failed: ${JSON.stringify(item.error)}`);
    assert.equal(item.result.cardIds.length, 1);
    return String(item.result.cardIds[0]);
  });

  // Three due Review cards; the first is advanced to a mature interval.
  await graduateToReview(cardIds[0]);
  let mature = await state(cardIds[0]);
  for (let step = 0; mature.intervalDays < 21 && step < 20; step++)
    mature = await answer(cardIds[0], "easy");
  assert(mature.type === "review" && mature.intervalDays >= 21);
  await setDue(cardIds[0], "0");
  for (const index of [1, 2, 3]) {
    await graduateToReview(cardIds[index]);
    await setDue(cardIds[index], "0");
  }
  // Two New cards remain untouched; the final Review card is ten days out.
  await graduateToReview(cardIds[6]);
  await setDue(cardIds[6], "10");

  for (const index of [0, 1, 2, 3]) {
    const eligibility = await call("scheduling.getDue", {
      cardId: cardIds[index],
    });
    assert.equal(eligibility.dueNow, true, `test word ${index} must be due now`);
  }
  for (const index of [4, 5, 6]) {
    const eligibility = await call("scheduling.getDue", {
      cardId: cardIds[index],
    });
    assert.equal(eligibility.dueNow, false, `test word ${index} must not be due now`);
  }
  assert((await state(cardIds[0])).intervalDays >= 21, "mature card lost its interval");

  const markup = testWords
    .map(
      (entry, index) =>
        `<span id="${wordId(index)}">${escapeHtml(entry.lemma)}</span>`,
    )
    .join(" ");
  fixtureHtml = fixtureTemplate.replace("__DUE_TODAY_WORDS__", markup);
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  browser = await puppeteer.launch({
    headless: false,
    enableExtensions: [resolve("dist")],
    args: ["--no-first-run"],
  });
  const worker = (await (
    await browser.waitForTarget((target) => target.type() === "service_worker")
  ).worker())!;
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
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 950 });
  await page.goto(base);
  const tabId = await worker.evaluate(
    async (baseUrl) =>
      (await chrome.tabs.query({})).find((tab) => tab.url?.startsWith(baseUrl))!
        .id!,
    base,
  );
  await worker.evaluate(
    async (id) =>
      chrome.scripting.executeScript({
        target: { tabId: id },
        files: ["content.js"],
      }),
    tabId,
  );
  await page.waitForFunction(
    (count) => CSS.highlights.get("voka-due")?.size === count,
    {},
    3,
  );
  const dueKeys = keys.slice(0, 4).sort();
  const dueWords = testWords.slice(0, 4).map((entry) => entry.lemma);
  const dueLayer = await page.evaluate(() =>
    [...(CSS.highlights.get("voka-due") ?? [])].map((range) => range.toString()),
  );
  assert.deepEqual([...dueLayer].sort(), dueWords.slice(0, 3).sort());
  const colorLayers = await page.evaluate(() =>
    Object.fromEntries(
      ["voka-target", "voka-learning", "voka-unknown", "voka-weak"].map(
        (name) => [
          name,
          [...(CSS.highlights.get(name) ?? [])].map((range) => range.toString()),
        ],
      ),
    ),
  ) as Record<string, string[]>;
  assert(
    Object.values(colorLayers).every((words) => !words.includes(testWords[3].lemma)),
    "the manually known due word must have no color highlight",
  );
  assert(
    !dueLayer.includes(testWords[3].lemma),
    "the manually known due word must have no underline",
  );
  assert(
    [4, 5, 6].every((index) => !dueLayer.includes(testWords[index].lemma)),
    "New and future Review words must not be underlined",
  );

  await page.waitForFunction(() => {
    const summary = document
      .getElementById("voka-drawer")
      ?.shadowRoot?.querySelector('[data-slot="due-summary"]')?.textContent;
    return /4/.test(summary ?? "");
  });
  const summary = await page.evaluate(
    () =>
      document
        .getElementById("voka-drawer")!
        .shadowRoot!.querySelector('[data-slot="due-summary"]')!.textContent,
  );
  assert.match(summary ?? "", /4/);
  assert.match(summary ?? "", /due today|今日到期/);

  await page.evaluate(() =>
    (
      document
        .getElementById("voka-drawer")!
        .shadowRoot!.querySelector(".drawer-toggle") as HTMLElement
    ).click(),
  );
  await page.evaluate(() =>
    (
      document
        .getElementById("voka-drawer")!
        .shadowRoot!.querySelector('[data-filter="due"]') as HTMLElement
    ).click(),
  );
  const listedKeys = await page.evaluate(() =>
    [
      ...document
        .getElementById("voka-drawer")!
        .shadowRoot!.querySelectorAll(".drawer-list button"),
    ].map((button) => (button as HTMLElement).dataset.key!),
  );
  assert.deepEqual([...listedKeys].sort(), dueKeys);

  await page.locator(`#${wordId(0)}`).hover();
  await page.waitForFunction(() => {
    const tooltip = document
      .getElementById("voka-drawer")
      ?.shadowRoot?.querySelector('[role="tooltip"]');
    return /Due today|今日到期/.test(tooltip?.textContent ?? "");
  });
  const tooltip = await page.evaluate(
    () =>
      document
        .getElementById("voka-drawer")!
        .shadowRoot!.querySelector('[role="tooltip"]')!.textContent,
  );
  assert(isDueBadge(tooltip ?? ""));
  await page.evaluate((key) => {
    const root = document.getElementById("voka-drawer")!.shadowRoot!;
    (root.querySelector(`.drawer-list button[data-key="${key}"]`) as HTMLElement).click();
  }, keys[1]);
  await page.waitForFunction(() => {
    const card = document
      .getElementById("voka-drawer")
      ?.shadowRoot?.querySelector("#voka-card");
    return (
      !!card &&
      !(card as HTMLElement).hidden &&
      /Due today|今日到期/.test(
        card.querySelector(".due-badge")?.textContent ?? "",
      )
    );
  });
  const cardBadge = await page.evaluate(
    () =>
      document
        .getElementById("voka-drawer")!
        .shadowRoot!.querySelector("#voka-card .due-badge")!.textContent,
  );
  assert(isDueBadge(cardBadge ?? ""));
  await page.evaluate(() => {
    document.getElementById("words")!.textContent = "";
    document.dispatchEvent(new Event("voka-refresh"));
  });
  await page.waitForFunction(() => {
    const empty = document
      .getElementById("voka-drawer")
      ?.shadowRoot?.querySelector('[data-slot="due-summary"]')?.textContent;
    return /Nothing due today on this page|本页没有今日到期的词/.test(empty ?? "");
  });

  console.log(
    JSON.stringify(
      {
        port: PORT,
        noteType: typeName,
        testDeck: TEST_DECK,
        words: testWords.map((entry, index) => ({
          word: entry.lemma,
          state:
            index < 4
              ? index === 3
                ? "known and due Review"
                : index === 0
                  ? "mature due Review"
                  : "due Review"
              : index < 6
                ? "New"
                : "Review due in ten days",
        })),
        checks: [
          "four distinct due words counted, including the known word",
          "mature due Review gets an underline without changing its existing color rule",
          "known due word has no underline or color, and remains in the due filter",
          "New and future Review words are not underlined",
          "due today badge appears in the tooltip and full card",
          "empty pages show the due-none summary",
        ],
      },
      null,
      2,
    ),
  );
} catch (error) {
  testFailed = error;
  throw error;
} finally {
  await browser?.close();
  if (server.listening)
    await new Promise<void>((resolveClose, rejectClose) =>
      server.close((error) => (error ? rejectClose(error) : resolveClose())),
    );
  if (deckWasAbsent && deckCreateAttempted) {
    const currentDecks = await call("decks.list");
    if (currentDecks.some((deck: any) => deck.name === TEST_DECK)) {
      const cleanupIds = await searchTestNotes();
      if (cleanupIds.length)
        for (let start = 0; start < cleanupIds.length; start += 100)
          await call(
            "notes.delete",
            { ids: cleanupIds.slice(start, start + 100) },
            true,
          );
      const leftovers = await searchTestNotes();
      assert.equal(leftovers.length, 0, "test notes were not fully cleaned up");
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
      assert(
        !decksAfter.some((deck: any) => deck.name === TEST_DECK),
        "test deck was not fully cleaned up",
      );
    }
    console.log("CLEANUP OK");
  } else if (testFailed) {
    throw new Error("Test failed before creating the reserved test deck", {
      cause: testFailed,
    });
  }
}
