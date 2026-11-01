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
const TEST_DECK = "VOKA Test::81";
const config = { port: PORT, apiKey: "" };
const call = (method: string, params = {}, write = false) =>
  rpc(config, method, params, { sideEffecting: write }) as Promise<any>;
const quote = (value: string) =>
  '"' + value.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
const escapeHtml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

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
const candidates = data.pack.entries.filter(
  (entry) => /^[a-z]{3,18}$/.test(entry.lemma) && entry.level === "B1",
);
const fixtureTemplate = await readFile(
  resolve("scripts/fixtures/practice.html"),
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
let testWords: typeof candidates = [];
let testFailed: unknown;

async function findUnusedEntries(count: number) {
  const unused: typeof candidates = [];
  for (let start = 0; start < candidates.length && unused.length < count; start += 100) {
    const batch = candidates.slice(start, start + 100);
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
      query: `note:${quote(typeName)} deck:${quote(TEST_DECK)}`,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    ids.push(...result.ids.map(String));
    cursor = result.nextCursor ?? undefined;
  } while (cursor);
  return ids;
}

async function snapshot(cardId: string) {
  const [latest, scheduling] = await Promise.all([
    call("reviews.getLatestId", { cardIds: [cardId] }),
    call("scheduling.get", { cardId }),
  ]);
  return { latest, scheduling };
}

async function answerNewCard(cardId: string) {
  const prediction = await call("scheduling.predict", { cardId });
  assert(
    prediction.answers.some((option: any) => option.rating === "easy"),
    `Anki did not offer Easy for ${cardId}`,
  );
  const result = await call(
    "scheduling.answer",
    {
      cardId,
      rating: "easy",
      stateToken: prediction.stateToken,
      elapsedMs: 250,
    },
    true,
  );
  return result.scheduling ?? call("scheduling.get", { cardId });
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
  testWords = await findUnusedEntries(2);
  const notes = await Promise.all(
    testWords.map(async (entry) => {
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
  const validation = await call("notes.validateMany", { notes });
  assert.equal(validation.items.length, notes.length);
  assert(
    validation.items.every((item: any) => item.result?.valid === true),
    `note validation failed: ${JSON.stringify(validation.items)}`,
  );
  const creation = await call(
    "notes.createMany",
    { notes, atomic: false },
    true,
  );
  assert(
    creation.items.every((item: any) => item.result?.noteId && !item.error),
    `note creation failed: ${JSON.stringify(creation.items)}`,
  );
  const noteIds = creation.items.map((item: any) => String(item.result.noteId));
  const noteResults = await call("notes.getMany", { ids: noteIds });
  const cardIds = noteResults.items.map((item: any) => {
    assert(!item.error, `note read failed: ${JSON.stringify(item.error)}`);
    assert.equal(item.result.cardIds.length, 1);
    return String(item.result.cardIds[0]);
  });

  // Keep the first generated card New and graduate only the second into Review.
  const newState = await call("scheduling.get", { cardId: cardIds[0] });
  assert.equal(newState.type, "new");
  const reviewState = await answerNewCard(cardIds[1]);
  assert.equal(reviewState.type, "review");
  await call(
    "scheduling.setDueDate",
    { cardIds: [cardIds[1]], days: "10" },
    true,
  );
  const futureDue = await call("scheduling.getDue", { cardId: cardIds[1] });
  assert.equal(futureDue.dueNow, false, "Review fixture must be due in ten days");

  const before = await Promise.all(cardIds.map(snapshot));
  fixtureHtml = fixtureTemplate.replace(
    "__PRACTICE_WORDS__",
    testWords
      .map(
        (entry, index) =>
          `<p>We can <span id="practice-${index}">${escapeHtml(entry.lemma)}</span> today.</p>`,
      )
      .join("\n"),
  );
  await new Promise<void>((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen),
  );
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
    (words) => {
      const layers = ["target", "learning", "unknown", "weak", "due"];
      const highlights = layers.flatMap((name) =>
        [...(CSS.highlights.get(`voka-${name}`) ?? [])].map((range) =>
          range.toString(),
        ),
      );
      return words.every((word) => highlights.includes(word));
    },
    {},
    testWords.map((entry) => entry.lemma),
  );

  for (let index = 0; index < testWords.length; index++) {
    await page.locator(`#practice-${index}`).click();
    await page.waitForFunction(() => {
      const root = document.getElementById("voka-drawer")?.shadowRoot;
      const card = root?.querySelector("#voka-card") as HTMLElement | null;
      const button = root?.querySelector("#voka-practice-word") as HTMLElement | null;
      return !!card && !card.hidden && !!button && !button.hasAttribute("disabled");
    });
    await page.evaluate(() =>
      (
        document
          .getElementById("voka-drawer")!
          .shadowRoot!.querySelector("#voka-practice-word") as HTMLButtonElement
      ).click(),
    );
    await page.waitForFunction(() => {
      const view = document
        .getElementById("voka-drawer")
        ?.shadowRoot?.querySelector('[data-slot="review-ui"]');
      return (
        !!view?.querySelector(".practice-label") &&
        !!view.querySelector("#voka-review-question")
      );
    });
    const front = await page.evaluate(() => {
      const view = document
        .getElementById("voka-drawer")!
        .shadowRoot!.querySelector('[data-slot="review-ui"]')!;
      return {
        label: view.querySelector(".practice-label")?.textContent ?? "",
        question: view.querySelector("#voka-review-question")?.textContent ?? "",
        sentence: view.querySelector(".review-sentence")?.textContent ?? "",
        ratingCount: view.querySelectorAll("[data-review-rating]").length,
      };
    });
    assert.match(front.label, /Practice|练习/);
    assert(front.question.length > 0, "rendered question is missing");
    assert(front.sentence.includes(testWords[index].lemma));
    assert.equal(front.ratingCount, 0, "rating button appeared on the front");

    await page.evaluate(() =>
      (
        document
          .getElementById("voka-drawer")!
          .shadowRoot!
          .querySelector('[data-practice-action="show-answer"]') as HTMLButtonElement
      ).click(),
    );
    await page.waitForFunction(() =>
      document
        .getElementById("voka-drawer")
        ?.shadowRoot?.querySelector('[data-slot="review-ui"] #voka-review-answer'),
    );
    const back = await page.evaluate(() => {
      const view = document
        .getElementById("voka-drawer")!
        .shadowRoot!.querySelector('[data-slot="review-ui"]')!;
      return {
        answer: view.querySelector("#voka-review-answer")?.textContent ?? "",
        ratingCount: view.querySelectorAll("[data-review-rating]").length,
        next: view.querySelector('[data-practice-action="next"]')?.textContent ?? "",
      };
    });
    assert(back.answer.length > 0, "rendered answer is missing");
    assert.equal(back.ratingCount, 0, "rating button appeared after answer reveal");
    assert.match(back.next, /Next|下一个/);
    await page.evaluate(() =>
      (
        document
          .getElementById("voka-drawer")!
          .shadowRoot!
          .querySelector('[data-practice-action="next"]') as HTMLButtonElement
      ).click(),
    );
    await page.waitForFunction(() =>
      (document
        .getElementById("voka-drawer")
        ?.shadowRoot?.querySelector('[data-slot="review-ui"]') as HTMLElement | null)
        ?.hidden,
    );
  }

  const after = await Promise.all(cardIds.map(snapshot));
  assert.deepEqual(after, before, "practice changed review history or scheduling state");
  console.log(
    JSON.stringify(
      {
        port: PORT,
        testDeck: TEST_DECK,
        cards: cardIds.map((cardId, index) => ({
          cardId,
          word: testWords[index].lemma,
          type: index === 0 ? "New" : "Review due in ten days",
        })),
        checks: [
          "full-card practice button opens practice for a New card and a future Review card",
          "question and page sentence appear before answer, then answer appears after reveal",
          "practice label remains visible and no rating buttons appear",
          "reviews.getLatestId and scheduling.get are unchanged for both cards",
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
