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
const TEST_DECK = "VOKA Test::99";
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
  (entry) =>
    /^[a-z]{3,18}$/.test(entry.lemma) &&
    entry.level === "B1" &&
    ![
      "before",
      "then",
      "after",
      "we",
      "read",
      "in",
      "this",
      "synthetic",
      "review",
      "fixture",
    ].includes(entry.lemma),
);
const fixtureTemplate = await readFile(
  resolve("scripts/fixtures/review.html"),
  "utf8",
);
let fixtureHtml = fixtureTemplate;
let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
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
  for (
    let start = 0;
    start < candidateEntries.length && unused.length < count;
    start += 100
  ) {
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

async function setDue(cardId: string) {
  await call("scheduling.setDueDate", { cardIds: [cardId], days: "0" }, true);
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

function markupFor(indices: number[]) {
  return indices
    .map(
      (index) =>
        `<span id="word-${index}">${escapeHtml(testWords[index].lemma)}</span>`,
    )
    .join(", then ");
}

function pageWith(indices: number[]) {
  const words = markupFor(indices);
  const sentence = `We read ${words} in this synthetic review fixture.`;
  return fixtureTemplate.replace("__REVIEW_SENTENCE__", sentence);
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

  testWords = await findUnusedEntries(6);
  const testNotes = await Promise.all(
    testWords.map(async (entry, index) => {
      const fields = Object.fromEntries(CORE_FIELDS.map((field) => [field, ""]));
      const escaped = {
        ...entry,
        Reading: escapeHtml(entry.Reading),
        GlossNative: escapeHtml(`SYNTHETIC_NATIVE_GLOSS_${index}`),
        GlossTarget: escapeHtml(`SYNTHETIC_TARGET_GLOSS_${index}`),
      };
      Object.assign(fields, {
        Key: normalizeKey(entry.lemma),
        Word: escapeHtml(entry.lemma),
        Variants: escapeHtml(entry.Variants ?? ""),
        Reading: escaped.Reading,
        GlossNative: escaped.GlossNative,
        GlossTarget: escaped.GlossTarget,
        Context1: escapeHtml(`Synthetic context for ${entry.lemma}.`),
        ManualStatus: "",
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

  for (const cardId of cardIds) {
    const scheduled = await answer(cardId, "easy");
    if (scheduled.type !== "review")
      throw new Error(`Expected ${cardId} to graduate to Review; got ${scheduled.type}`);
    await setDue(cardId);
    const due = await call("scheduling.getDue", { cardId });
    assert.equal(due.dueNow, true, `${cardId} must be due now`);
  }
  const initialStates = await Promise.all(cardIds.map(state));
  const startingReviewIds = await Promise.all(
    cardIds.map(async (cardId) =>
      (await call("reviews.getLatestId", { cardIds: [cardId] })).id,
    ),
  );

  fixtureHtml = pageWith([0, 1, 2, 3]);
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
  async function inject(path: string) {
    await page.goto(`${base}/${path}`);
    const tabId = await worker.evaluate(
      async (url) =>
        (await chrome.tabs.query({})).find((tab) => tab.url?.startsWith(url))!
          .id!,
      `${base}/${path}`,
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
      () => CSS.highlights.get("voka-due")?.size > 0,
    );
    return tabId;
  }

  await inject("review-button");
  await page.waitForFunction(() => {
    const button = document
      .getElementById("voka-drawer")
      ?.shadowRoot?.querySelector('[data-slot="review-button"]') as HTMLButtonElement | null;
    return !!button && !button.hidden;
  });
  await page.evaluate(() => {
    const root = document.getElementById("voka-drawer")!.shadowRoot!;
    (root.querySelector('[data-slot="review-button"]') as HTMLButtonElement).click();
  });
  await page.waitForFunction(
    () =>
      !!document
        .getElementById("voka-drawer")
        ?.shadowRoot?.querySelector("#voka-review-question"),
  );
  const headerReviewStarted = await page.evaluate(() => {
    const root = document.getElementById("voka-drawer")!.shadowRoot!;
    return {
      questionVisible: !!root.querySelector("#voka-review-question"),
      expanded: root.querySelector(".drawer-toggle")?.getAttribute("aria-expanded"),
    };
  });
  assert(headerReviewStarted.questionVisible, "header Review button did not start the due queue");
  assert.equal(headerReviewStarted.expanded, "true", "header Review button must expand the drawer");

  // Reload before T-14 so the existing due-summary assertion remains unchanged.
  await inject("t14");
  await page.waitForFunction(() => {
    const summary = document
      .getElementById("voka-drawer")
      ?.shadowRoot?.querySelector('[data-slot="due-summary"]')?.textContent;
    return /4/.test(summary ?? "");
  });
  await page.evaluate(() =>
    (
      document
        .getElementById("voka-drawer")!
        .shadowRoot!.querySelector('[data-slot="due-summary"]') as HTMLButtonElement
    ).click(),
  );
  await page.waitForFunction(
    () =>
      !!document
        .getElementById("voka-drawer")
        ?.shadowRoot?.querySelector("#voka-review-question"),
  );

  const firstFront = await page.evaluate(() => {
    const root = document.getElementById("voka-drawer")!.shadowRoot!;
    const view = root.querySelector("#voka-review-ui")!;
    return {
      text: root.querySelector("#voka-review-question")?.textContent ?? "",
      answerVisible: !!root.querySelector("#voka-review-answer"),
      sentenceBold: !!view.querySelector(".review-sentence b"),
      buttons: [...view.querySelectorAll(".review-actions button")].map(
        (button) => button.textContent,
      ),
    };
  });
  assert(!firstFront.answerVisible, "answer must stay hidden before reveal");
  assert(firstFront.sentenceBold, "the encountered word must be bold in the sentence");
  assert(
    !firstFront.text.includes("SYNTHETIC_NATIVE_GLOSS_0") &&
      !firstFront.text.includes("SYNTHETIC_TARGET_GLOSS_0"),
    "T-13 front exposed a gloss before Show answer",
  );
  const firstPrediction = await call("scheduling.predict", {
    cardId: cardIds[0],
  });
  await page.evaluate(() => {
    const root = document.getElementById("voka-drawer")!.shadowRoot!;
    (root.querySelector("#voka-review-ui .review-actions button") as HTMLButtonElement).click();
  });
  await page.waitForFunction(() => {
    const root = document.getElementById("voka-drawer")?.shadowRoot;
    return !!root?.querySelector("#voka-review-answer") &&
      !!root?.querySelector('[data-review-rating]');
  });
  const revealed = await page.evaluate(() => {
    const root = document.getElementById("voka-drawer")!.shadowRoot!;
    const view = root.querySelector("#voka-review-ui")!;
    return {
      text: root.querySelector("#voka-review-answer")?.textContent ?? "",
      ratings: [...view.querySelectorAll("[data-review-rating]")].map(
        (button) => (button as HTMLElement).dataset.reviewRating,
      ),
      labels: [...view.querySelectorAll("[data-review-rating]")].map(
        (button) => button.textContent,
      ),
    };
  });
  assert(revealed.text.includes("SYNTHETIC_NATIVE_GLOSS_0"));
  assert(revealed.text.includes("SYNTHETIC_TARGET_GLOSS_0"));
  assert.equal(revealed.ratings.length, firstPrediction.answers.length);
  firstPrediction.answers.forEach((option: any, index: number) => {
    if (option.interval !== null)
      assert(
        revealed.labels[index]?.includes(option.label),
        `rating button did not show Anki label ${option.label}`,
      );
  });

  const uiRatings = ["good", "hard", "again", "easy"] as const;
  for (let index = 0; index < 4; index++) {
    if (index > 0) {
      await page.waitForFunction(
        (word) => {
          const heading = document
            .getElementById("voka-drawer")
            ?.shadowRoot?.querySelector("#voka-review-ui h3")?.textContent;
          return heading?.startsWith(word) === true;
        },
        {},
        testWords[index].lemma,
      );
      await page.evaluate(() => {
        const root = document.getElementById("voka-drawer")!.shadowRoot!;
        (root.querySelector("#voka-review-ui .review-actions button") as HTMLButtonElement).click();
      });
      await page.waitForFunction(() =>
        !!document
          .getElementById("voka-drawer")
          ?.shadowRoot?.querySelector('[data-review-rating]'),
      );
    }

    const before = initialStates[index];
    const rating = uiRatings[index];
    const baseline = startingReviewIds[index];
    const countBefore = index === 0 ? 4 : undefined;
    await page.evaluate((value) => {
      const root = document.getElementById("voka-drawer")!.shadowRoot!;
      const button = root.querySelector(
        `[data-review-rating="${value}"]`,
      ) as HTMLButtonElement;
      if (!button) throw new Error(`missing ${value} rating button`);
      button.click();
    }, rating);

    if (index === 0) {
      try {
        await page.waitForFunction(() => {
          const root = document.getElementById("voka-drawer")?.shadowRoot;
          const dueText = root?.querySelector('[data-slot="due-summary"]')?.textContent;
          const dueRanges = [...(CSS.highlights.get("voka-due") ?? [])].map((range) => range.toString());
          return /3/.test(dueText ?? "") && !dueRanges.includes(
            document.querySelector("#word-0")?.textContent ?? "",
          );
        }, { timeout: 30000 });
      } catch (error) {
        const snapshot = await page.evaluate(() => {
          const root = document.getElementById("voka-drawer")?.shadowRoot;
          return {
            dueSummary: root?.querySelector('[data-slot="due-summary"]')?.textContent,
            dueRanges: [...(CSS.highlights.get("voka-due") ?? [])].map((range) => range.toString()),
            reviewHeading: root?.querySelector("#voka-review-ui h3")?.textContent,
            reviewStatus: root?.querySelector("#voka-review-status")?.textContent,
          };
        });
        const ankiSnapshot = {
          due: await call("scheduling.getDue", { cardId: cardIds[0] }),
          latestReviewId: (
            await call("reviews.getLatestId", { cardIds: [cardIds[0]] })
          ).id,
          reviews: await call("reviews.list", {
            cardIds: [cardIds[0]],
            afterId: startingReviewIds[0],
            limit: 20,
          }),
          scheduling: await state(cardIds[0]),
        };
        throw new Error(
          `T-18 did not refresh: ${JSON.stringify({ snapshot, ankiSnapshot })}`,
          { cause: error },
        );
      }
      const afterDue = await page.evaluate(() => {
        const root = document.getElementById("voka-drawer")!.shadowRoot!;
        return {
          summary: root.querySelector('[data-slot="due-summary"]')?.textContent,
          highlighted: [...(CSS.highlights.get("voka-due") ?? [])].map((range) => range.toString()),
        };
      });
      assert(!afterDue.highlighted.includes(testWords[0].lemma), "T-18 due underline remained");
      assert.equal(Number(afterDue.summary?.match(/\d+/)?.[0]), countBefore! - 1);
    }

    try {
      await page.waitForFunction(
        (nextWord, finished) => {
          const root = document.getElementById("voka-drawer")?.shadowRoot;
          const heading = root?.querySelector("#voka-review-ui h3")?.textContent ?? "";
          return finished
            ? /You finished today's due words|本页今日到期的词复习完了/.test(heading)
            : heading.startsWith(nextWord);
        },
        { timeout: 30000 },
        testWords[index + 1]?.lemma ?? "",
        index === 3,
      );
    } catch (error) {
      const snapshot = await page.evaluate(() => {
        const root = document.getElementById("voka-drawer")?.shadowRoot;
        return {
          reviewHeading: root?.querySelector("#voka-review-ui h3")?.textContent,
          reviewStatus: root?.querySelector("#voka-review-status")?.textContent,
          actions: Array.from(root?.querySelectorAll("#voka-review-ui .review-actions button") ?? []).map((button) => ({
            text: button.textContent,
            disabled: (button as HTMLButtonElement).disabled,
          })),
          dueSummary: root?.querySelector('[data-slot="due-summary"]')?.textContent,
        };
      });
      throw new Error(`Review did not advance: ${JSON.stringify(snapshot)}`, { cause: error });
    }

    const records = await call("reviews.list", {
      cardIds: [cardIds[index]],
      afterId: baseline,
      limit: 20,
    });
    const matching = records.items.filter(
      (item: any) =>
        String(item.cardId) === cardIds[index] && item.rating === rating,
    );
    assert.equal(matching.length, 1, `T-14 expected one ${rating} review for card ${index}`);
    assert.equal(records.items.length, 1, `T-14 expected one review after the baseline for card ${index}`);
    const after = await state(cardIds[index]);
    assert.notDeepEqual(after, before, `T-14 scheduling state did not change for card ${index}`);
  }
  await page.waitForFunction(() =>
    !!document
      .getElementById("voka-drawer")
      ?.shadowRoot?.querySelector("#voka-review-ui button"),
  );
  await page.evaluate(() => {
    const root = document.getElementById("voka-drawer")!.shadowRoot!;
    const buttons = [...root.querySelectorAll("#voka-review-ui button")];
    const done = buttons.find((button) => /Return to list|返回列表/.test(button.textContent ?? ""));
    (done as HTMLButtonElement).click();
  });

  // T-15 uses a fresh page queue containing only the fifth test card.
  fixtureHtml = pageWith([4]);
  await inject("t15");
  await page.evaluate(() => {
    const root = document.getElementById("voka-drawer")!.shadowRoot!;
    (root.querySelector(".drawer-toggle") as HTMLButtonElement).click();
    (root.querySelector('[data-filter="due"]') as HTMLButtonElement).click();
  });
  await page.waitForFunction(() => {
    const button = document
      .getElementById("voka-drawer")
      ?.shadowRoot?.querySelector(".drawer-start-review") as HTMLButtonElement | null;
    return !!button && !button.hidden;
  });
  await page.evaluate(() => {
    const root = document.getElementById("voka-drawer")!.shadowRoot!;
    (root.querySelector(".drawer-start-review") as HTMLButtonElement).click();
  });
  await page.waitForFunction(() =>
    !!document
      .getElementById("voka-drawer")
      ?.shadowRoot?.querySelector("#voka-review-question"),
  );
  await page.evaluate(() => {
    const root = document.getElementById("voka-drawer")!.shadowRoot!;
    (root.querySelector("#voka-review-ui .review-actions button") as HTMLButtonElement).click();
  });
  await page.waitForFunction(() =>
    !!document
      .getElementById("voka-drawer")
      ?.shadowRoot?.querySelector('[data-review-rating]'),
  );
  const fifthLatest = startingReviewIds[4];
  await answer(cardIds[4], "good");
  const directReviewState = await state(cardIds[4]);
  await page.evaluate(() => {
    const root = document.getElementById("voka-drawer")!.shadowRoot!;
    (root.querySelector('[data-review-rating="hard"]') as HTMLButtonElement).click();
  });
  await page.waitForFunction(() => {
    const status = document
      .getElementById("voka-drawer")
      ?.shadowRoot?.querySelector("#voka-review-status")?.textContent;
    return /Already completed in Anki; skipping|已在 Anki 里完成，跳过/.test(status ?? "");
  });
  const fifthRecords = await call("reviews.list", {
    cardIds: [cardIds[4]],
    afterId: fifthLatest,
    limit: 20,
  });
  assert.equal(fifthRecords.items.length, 1, "T-15 must not add a second review record");
  assert.equal(fifthRecords.items[0].rating, "good", "T-15 should only contain the direct Anki rating");
  assert.notDeepEqual(await state(cardIds[4]), initialStates[4]);
  assert.notDeepEqual(directReviewState, initialStates[4]);

  // T-16 simulates a response lost after Anki accepted the single answer.
  const cardId = cardIds[5];
  const latestReviewId = startingReviewIds[5];
  const prediction = await call("scheduling.predict", { cardId });
  let answerCalls = 0;
  const timeoutAfterAcceptance = async (
    method: string,
    params: Record<string, unknown> = {},
  ) => {
    const result = await call(
      method,
      params,
      method === "scheduling.answer",
    );
    if (method === "scheduling.answer") {
      answerCalls++;
      throw new Error("simulated response timeout after acceptance");
    }
    return result;
  };
  const confirmed = await submitReview(timeoutAfterAcceptance, {
    cardId,
    rating: "easy",
    stateToken: prediction.stateToken,
    elapsedMs: 250,
    latestReviewId,
  });
  assert.equal(confirmed.outcome, "confirmed", "T-16 should confirm the accepted review");
  assert.equal(answerCalls, 1, "T-16 must call scheduling.answer exactly once");
  const sixthRecords = await call("reviews.list", {
    cardIds: [cardId],
    afterId: latestReviewId,
    limit: 20,
  });
  assert.equal(sixthRecords.items.length, 1, "T-16 should create exactly one review record");
  assert.equal(sixthRecords.items[0].rating, "easy");
  assert.notDeepEqual(await state(cardId), initialStates[5]);

  console.log(
    JSON.stringify(
      {
        port: PORT,
        noteType: typeName,
        testDeck: TEST_DECK,
        words: testWords.map((entry, index) => ({
          word: entry.lemma,
          scenario:
            index < 4
              ? `T-14 ${uiRatings[index]} through the review UI`
              : index === 4
                ? "T-15 already answered directly through Anki"
                : "T-16 accepted answer with simulated timeout",
        })),
        checks: [
          "T-13: question and local sentence appear before either gloss; answer appears after Show answer",
          "T-14: Again, Hard, Good and Easy each create one review and change scheduling state",
          "T-15: due recheck skips a card answered in Anki and creates no second review",
          "T-16: timeout readback confirms the accepted answer without retrying",
          "T-18: due underline disappears and page due count falls after grading",
          "header Review button is visible, expands the drawer, and starts the due queue",
          "due summary and due-filter Start review entry points both open the queue",
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
