/**
 * Whole-level import acceptance (#32), isolated Anki 8766 only.
 *
 * T-03/T-04/T-07/cancel run through the real options UI against throwaway
 * deck/note-type names selected by the test-only `testImportTarget` storage
 * override. T-06 uses the real product note type for one manual A2 note.
 * Artifacts are recorded in docs/research/level-import-evidence/artifacts.json
 * and removed by scripts/cleanup-level-import.ts, never by product code.
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import puppeteer from "puppeteer";
import { createData } from "../src/data/index.ts";
import {
  DEFAULT_TARGET,
  executeImport,
  lookup,
  previewImport,
} from "../src/background/import.ts";
import { checkConnection, rpc } from "../src/background/gateway.ts";
import { cardContext } from "../src/background/contexts.ts";

const PORT = 8766;
const config = { port: PORT, apiKey: "" };
assert.equal(await checkConnection(config), "ok");

const names = [
  "cefrj",
  "octanove",
  "oewn",
  "readings",
  "oewn-readings",
  "morphology",
];
const packs = await Promise.all(
  names.map(async (name) =>
    JSON.parse(await readFile(`public/data/${name}.json`, "utf8")),
  ),
);
const data = createData(packs);
const entries = data.pack.entries;
const levelCount = (level: string) =>
  entries.filter((entry) => entry.level === level).length;
assert.equal(levelCount("B1"), 2085);
assert.equal(levelCount("A1"), 1050);
const b1Entries = entries.filter((entry) => entry.level === "B1");
const a1Entries = entries.filter((entry) => entry.level === "A1");

const databaseBefore = sqliteSnapshot();
const stamp = Date.now();
const targetA = {
  noteType: `VOKA Level Import Acceptance A ${stamp}`,
  deckPrefix: `VOKA::Level Import Acceptance A ${stamp}`,
};
const targetB = {
  noteType: `VOKA Level Import Acceptance B ${stamp}`,
  deckPrefix: `VOKA::Level Import Acceptance B ${stamp}`,
};
const targetC = {
  noteType: `VOKA Level Import Acceptance C ${stamp}`,
  deckPrefix: `VOKA::Level Import Acceptance C ${stamp}`,
};
const evidenceDir = "docs/research/level-import-evidence";
await mkdir(evidenceDir, { recursive: true });
const artifacts: {
  stamp: number;
  targets: {
    noteType: string;
    deckPrefix: string;
    levels: string[];
    purpose: string;
  }[];
  manualNotes: string[];
  manualDeck: { name: string; createdByTest: boolean };
} = {
  stamp,
  targets: [
    { ...targetA, levels: ["B1"], purpose: "T-03/T-04/T-07 UI" },
    { ...targetB, levels: ["B1"], purpose: "interrupt/resume" },
    { ...targetC, levels: ["A1"], purpose: "UI cancel/resume" },
  ],
  manualNotes: [],
  manualDeck: { name: "VOKA::English::A2", createdByTest: false },
};
const saveArtifacts = () =>
  writeFile(
    `${evidenceDir}/artifacts.json`,
    JSON.stringify(artifacts, null, 2),
  );
await saveArtifacts();

const quote = (value: string) =>
  '"' + value.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
const call = async (method: string, params: any = {}, write = false): Promise<any> =>
  rpc(config, method, params, { sideEffecting: write });
async function searchIds(method: "notes.search" | "cards.search", query: string) {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await call(method, {
      query,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    ids.push(...page.ids);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return ids;
}
async function getMany(method: "notes.getMany" | "cards.getMany", ids: string[]) {
  const items: any[] = [];
  for (let start = 0; start < ids.length; start += 100) {
    const page = await call(method, { ids: ids.slice(start, start + 100) });
    for (const item of page.items) {
      if (item.error)
        throw new Error(`${method}: ${JSON.stringify(item.error)}`);
      items.push(item.result);
    }
  }
  return items;
}
async function snapshotTarget(target: { noteType: string; deck: string }) {
  const noteIds = await searchIds(
    "notes.search",
    `note:${quote(target.noteType)} deck:${quote(target.deck)}`,
  );
  const notes = (await getMany("notes.getMany", noteIds)).sort(
    (a: any, b: any) => Number(a.id) - Number(b.id),
  );
  const cardIds = [
    ...new Set(notes.flatMap((note: any) => note.cardIds ?? [])),
  ];
  const cards = (await getMany("cards.getMany", cardIds)).sort(
    (a: any, b: any) => Number(a.id) - Number(b.id),
  );
  return { noteCount: notes.length, cardCount: cards.length, notes, cards };
}
function sqliteSnapshot() {
  return JSON.parse(
    execFileSync("python3", ["scripts/anki-snapshot.py"], {
      encoding: "utf8",
    }),
  );
}

const started = Date.now();
const evidence: Record<string, any> = {
  date: new Date().toISOString(),
  anki: await call("api.describe").then((describe: any) => ({
    version: describe.ankiVersion,
    apiMajor: describe.apiMajor,
  })),
  data: {
    version: data.pack.version,
    source: data.pack.source,
    counts: Object.fromEntries(
      ["A1", "A2", "B1", "B2", "C1", "C2"].map((level) => [
        level,
        levelCount(level),
      ]),
    ),
  },
};
let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
try {
  browser = await puppeteer.launch({
    headless: false,
    enableExtensions: [resolve("dist")],
    args: ["--no-first-run"],
  });
  const worker = (await (
    await browser.waitForTarget((target) => target.type() === "service_worker")
  ).worker())!;
  const extensionId = worker.url().split("/")[2];
  await worker.evaluate(
    (target) =>
      chrome.storage.local.set({
        port: 8766,
        apiKey: "",
        nativeLanguage: "zh",
        glossLanguage: "native",
        targetLevel: "B1",
        showAdvanced: false,
        hoverScope: "highlighted",
        testImportTarget: target,
      }),
    targetA,
  );
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 1100 });
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await page.waitForFunction(
    () => document.querySelector("#status")?.textContent === "已连接",
    { timeout: 30000 },
  );
  await page.waitForFunction(
    () => document.querySelectorAll("#levels input").length === 6,
    { timeout: 30000 },
  );
  await page.select("#importLevel", "B1");

  // T-03 preview.
  await page.click("#preview");
  await page.waitForFunction(
    () =>
      document.querySelector("#importCounts")?.textContent?.includes(
        "新建 2,085",
      ),
    { timeout: 120000 },
  );
  const previewText = await page.$eval(
    "#importStatus",
    (element) => element.textContent!,
  );
  assert.match(previewText, /目标牌组：VOKA::Level Import Acceptance A/);
  assert.match(previewText, /笔记类型：VOKA Level Import Acceptance A/);
  assert.match(previewText, /新建 2,085 \/ 已存在 0 \/ 冲突 0 \/ 跳过 0/);
  assert.match(await page.$eval("#importTarget", (e) => e.textContent!), /新建/);
  assert.match(
    await page.$eval("#importConflicts", (e) => e.textContent!),
    /冲突 Key：无/,
  );
  const pageText = await page.evaluate(() => document.body.textContent!);
  for (const required of [
    "不会修改、移动或重置任何已有卡片",
    "新卡由 Anki 按你的每日新卡上限逐步引入",
    "不导入的话，无法使用上下文复习",
    data.pack.version,
  ])
    assert(pageText.includes(required), `missing UI promise: ${required}`);
  await page.screenshot({ path: `${evidenceDir}/preview.png`, fullPage: true });

  // T-03 execution, observing the real progress bar.
  await page.evaluate(() => {
    (window as any).__vokaProgress = [];
    (window as any).__vokaProgressTimer = setInterval(() => {
      const bar = document.querySelector(
        "#importProgress",
      ) as HTMLProgressElement | null;
      if (bar)
        (window as any).__vokaProgress.push({
          hidden: bar.hidden,
          value: bar.value,
          max: bar.max,
          text: document.querySelector("#importProgressText")?.textContent,
        });
    }, 50);
  });
  const importStarted = Date.now();
  await page.click("#confirm");
  const progressObserved = await page
    .waitForFunction(
      () => {
        const bar = document.querySelector(
          "#importProgress",
        ) as HTMLProgressElement;
        return bar && !bar.hidden && bar.value > 0 && bar.value < bar.max;
      },
      { timeout: 120000, polling: 50 },
    )
    .then(() => true)
    .catch(() => false);
  if (progressObserved)
    await page.screenshot({ path: `${evidenceDir}/progress.png` });
  await page.waitForFunction(
    () =>
      document.querySelector("#importCounts")?.textContent?.includes(
        "新建 0 ",
      ) && document.querySelector("#confirm")?.hasAttribute("disabled"),
    { timeout: 600000, polling: 200 },
  );
  const importElapsed = Date.now() - importStarted;
  const progressSamples = await page.evaluate(() => {
    clearInterval((window as any).__vokaProgressTimer);
    return (window as any).__vokaProgress as any[];
  });
  assert(
    progressObserved,
    "progress bar never showed an in-flight value",
  );
  assert(
    progressSamples.some(
      (sample) => !sample.hidden && sample.value > 0 && sample.value < sample.max,
    ),
    "progress samples did not include an in-flight value",
  );
  const doneText = await page.$eval(
    "#importProgressText",
    (element) => element.textContent!,
  );
  assert.match(doneText, /已完成：本次新建 2,085 条/);
  assert.equal(
    await page.$eval("#finish", (e: HTMLButtonElement) => e.disabled),
    false,
  );
  await page.screenshot({ path: `${evidenceDir}/done.png`, fullPage: true });

  // T-03/T-04 real counts, tags, and repeated import.
  const noteIdsA = await searchIds(
    "notes.search",
    `note:${quote(targetA.noteType)}`,
  );
  assert.equal(noteIdsA.length, 2085);
  const deckA = `${targetA.deckPrefix}::B1`;
  assert.equal(
    (
      await searchIds(
        "cards.search",
        `note:${quote(targetA.noteType)} deck:${quote(deckA)}`,
      )
    ).length,
    2085,
  );
  assert.equal(
    (
      await call("notes.search", {
        query: `note:${quote(targetA.noteType)} -tag:voka`,
        limit: 1,
      })
    ).ids.length,
    0,
  );
  assert.equal(
    (
      await call("notes.search", {
        query: `note:${quote(targetA.noteType)} -tag:voka::level::B1`,
        limit: 1,
      })
    ).ids.length,
    0,
  );
  const targetATarget = {
    noteType: targetA.noteType,
    deck: deckA,
  };
  const beforeRepeat = await snapshotTarget(targetATarget);
  assert.equal(beforeRepeat.noteCount, 2085);
  assert.equal(beforeRepeat.cardCount, 2085);
  const methodsBeforeRepeat = new Set<string>();
  const repeatCall = async (method: string, params: any = {}, write = false) => {
    methodsBeforeRepeat.add(method);
    return rpc(config, method, params, { sideEffecting: write });
  };
  const repeatStarted = Date.now();
  const repeat = await executeImport(
    repeatCall,
    targetATarget,
    "native",
    "zh",
    entries,
  );
  const repeatElapsed = Date.now() - repeatStarted;
  assert.deepEqual(repeat.failures, []);
  assert.equal(repeat.created, 0);
  assert.equal(repeat.total, 0);
  for (const method of [
    "notes.validateMany",
    "notes.createMany",
    "decks.create",
    "noteTypes.create",
  ])
    assert(!methodsBeforeRepeat.has(method), `repeat import called ${method}`);
  assert.deepEqual(await snapshotTarget(targetATarget), beforeRepeat);

  // T-07: target-level switching only changes settings and offers the new level.
  const beforeSwitch = await snapshotTarget(targetATarget);
  await page.click('input[name="targetLevel"][value="B2"]');
  await page.waitForFunction(
    async () =>
      (await chrome.storage.local.get("targetLevel")).targetLevel === "B2",
    { timeout: 30000 },
  );
  assert.equal(
    await page.$eval("#importLevel", (select: HTMLSelectElement) => select.value),
    "B2",
  );
  const hintB2 = await page.$eval("#levelHint", (element) => element.textContent!);
  assert.match(hintB2, /B2/);
  assert.match(hintB2, /不会删除、移动或重置旧卡/);
  assert.match(hintB2, /预览并导入/);
  await page.screenshot({ path: `${evidenceDir}/level-b2.png`, fullPage: true });
  await page.click('input[name="targetLevel"][value="B1"]');
  await page.waitForFunction(
    async () =>
      (await chrome.storage.local.get("targetLevel")).targetLevel === "B1",
    { timeout: 30000 },
  );
  assert.equal(
    await page.$eval("#importLevel", (select: HTMLSelectElement) => select.value),
    "B1",
  );
  assert.deepEqual(await snapshotTarget(targetATarget), beforeSwitch);
  assert.equal(
    (await snapshotTarget(targetATarget)).noteCount,
    2085,
    "switching levels changed B1 notes",
  );

  // Cancel keeps written notes; continuing fills only the remainder (A1, UI).
  await worker.evaluate(
    (target) =>
      chrome.storage.local.set({ testImportTarget: target, targetLevel: "A1" }),
    targetC,
  );
  await page.reload();
  await page.waitForFunction(
    () => document.querySelector("#status")?.textContent === "已连接",
    { timeout: 30000 },
  );
  await page.waitForFunction(
    () => document.querySelectorAll("#levels input").length === 6,
    { timeout: 30000 },
  );
  assert.equal(
    await page.$eval("#importLevel", (select: HTMLSelectElement) => select.value),
    "A1",
  );
  await page.click("#preview");
  await page.waitForFunction(
    () =>
      document.querySelector("#importCounts")?.textContent?.includes(
        "新建 1,050",
      ),
    { timeout: 120000 },
  );
  const cancelStarted = Date.now();
  await page.click("#confirm");
  await page.waitForFunction(
    () => {
      const bar = document.querySelector(
        "#importProgress",
      ) as HTMLProgressElement;
      return bar && !bar.hidden && bar.value > 0 && bar.value < bar.max;
    },
    { timeout: 120000, polling: 50 },
  );
  await page.click("#cancelImport");
  await page.waitForFunction(
    () =>
      document.querySelector("#importProgressText")?.textContent?.includes(
        "已取消：本次新建",
      ) &&
      document.querySelector("#confirm")?.textContent?.includes("继续导入"),
    { timeout: 300000, polling: 200 },
  );
  const cancelElapsed = Date.now() - cancelStarted;
  const cancelText = await page.$eval(
    "#importProgressText",
    (element) => element.textContent!,
  );
  const createdMatch = cancelText.match(/本次新建 ([\d,]+) 条/);
  assert(createdMatch, `cancel summary missing count: ${cancelText}`);
  const cancelledCreated = Number(createdMatch[1].replaceAll(",", ""));
  assert(cancelledCreated > 0 && cancelledCreated < 1050);
  const targetCTarget = {
    noteType: targetC.noteType,
    deck: `${targetC.deckPrefix}::A1`,
  };
  const afterCancel = await snapshotTarget(targetCTarget);
  assert.equal(afterCancel.noteCount, cancelledCreated);
  assert.equal(afterCancel.cardCount, cancelledCreated);
  const continueText = await page.$eval(
    "#confirm",
    (element) => element.textContent!,
  );
  assert.match(continueText, /继续导入（剩余/);
  assert.equal(
    await page.$eval("#confirm", (e: HTMLButtonElement) => e.disabled),
    false,
  );
  await page.screenshot({
    path: `${evidenceDir}/cancelled.png`,
    fullPage: true,
  });
  const resumeStarted = Date.now();
  await page.click("#confirm");
  await page.waitForFunction(
    () =>
      document.querySelector("#importCounts")?.textContent?.includes(
        "新建 0 ",
      ),
    { timeout: 600000, polling: 200 },
  );
  const resumeElapsed = Date.now() - resumeStarted;
  const afterResume = await snapshotTarget(targetCTarget);
  assert.equal(afterResume.noteCount, 1050);
  assert.equal(afterResume.cardCount, 1050);
  const keyCounts = await lookup(
    call,
    targetCTarget,
    a1Entries.map((entry) => "en:" + entry.lemma),
  );
  assert(
    [...keyCounts.values()].every((ids) => ids.length === 1),
    "A1 resume produced duplicate Keys",
  );
  await page.screenshot({
    path: `${evidenceDir}/resumed.png`,
    fullPage: true,
  });

  evidence.ui = {
    preview:
      "新建 2,085 / 已存在 0 / 冲突 0 / 跳过 0; deck and type 新建; promises and version visible",
    t03Ms: importElapsed,
    progressSamples: progressSamples.filter(
      (sample) =>
        !sample.hidden && sample.value > 0 && sample.value < sample.max,
    ).length,
    t04Ms: repeatElapsed,
    t04:
      "preview new 0; confirm disabled; execute created 0 and called no validate/create/deck/type writes",
    t07:
      "B1→B2→B1 kept targetLevel/importLevel in sync, showed the no-delete hint, and every B1 note/card payload was byte-identical",
    cancel: {
      ms: cancelElapsed,
      createdBeforeCancel: cancelledCreated,
      summary: cancelText,
      keptNotes: afterCancel.noteCount,
      resumeMs: resumeElapsed,
      finalNotes: afterResume.noteCount,
    },
  };
} finally {
  await browser?.close();
}

// T-06: a manually added A2 word is already existing when A2 is imported.
const a2Target = { noteType: DEFAULT_TARGET.noteType, deck: "VOKA::English::A2" };
const decksBeforeT06: { name: string }[] = await call("decks.list");
artifacts.manualDeck.createdByTest = !decksBeforeT06.some(
  (deck) => deck.name === a2Target.deck,
);
const a2Preview = await previewImport(call, a2Target, entries);
const a2Candidate = a2Preview.rows.find(
  (row) => row.state === "new" && row.entry.level === "A2",
);
assert(a2Candidate, "no new A2 word available for T-06");
const manualKey = a2Candidate.key;
assert.equal(data.lookupEntry(manualKey).level, "A2");
const manualLemma = a2Candidate.entry.lemma;
const sentence = `This manual A2 sentence mentions ${manualLemma} clearly.`;
const sentenceHtml = sentence.replace(manualLemma, `<b>${manualLemma}</b>`);
const manual = await cardContext(
  call,
  {
    key: manualKey,
    action: "save",
    text: sentence,
    html: sentenceHtml,
    url: "https://example.com/voka-level-import-acceptance",
    title: "VOKA level import acceptance",
  },
  {
    nativeLanguage: "zh",
    glossLanguage: "native",
    targetLevel: "B1",
    showAdvanced: false,
    hoverScope: "highlighted",
    storeFullUrl: false,
  },
  async (key) => data.lookupEntry(key),
);
assert.equal(manual.exists, true);
assert.equal(manual.fields.Key, manualKey);
const manualIds = (await lookup(call, a2Target, [manualKey])).get(manualKey)!;
assert.equal(manualIds.length, 1);
artifacts.manualNotes.push(...manualIds);
await saveArtifacts();
const a2After = await previewImport(call, a2Target, entries);
const manualRow = a2After.rows.find((row) => row.key === manualKey)!;
assert.equal(manualRow.state, "existing");
assert.equal(a2After.counts.existing, a2Preview.counts.existing + 1);
evidence.t06 = {
  key: manualKey,
  deck: a2Target.deck,
  deckCreatedByTest: artifacts.manualDeck.createdByTest,
  previewBefore: a2Preview.counts,
  previewAfter: a2After.counts,
  noteIds: manualIds,
  "single note": true,
};

// Interruption: switch the live gateway to a closed port, then resume.
const closed = createServer();
await new Promise<void>((done) => closed.listen(0, "127.0.0.1", done));
const closedPort = (closed.address() as { port: number }).port;
await new Promise<void>((done) => closed.close(() => done()));
const configB = { port: PORT, apiKey: "" };
const callB = async (method: string, params: any = {}, write = false) =>
  rpc(configB, method, params, { sideEffecting: write });
const targetBTarget = {
  noteType: targetB.noteType,
  deck: `${targetB.deckPrefix}::B1`,
};
const previewB = await previewImport(callB, targetBTarget, entries);
assert.equal(previewB.counts.new, 2085);
let switched = false;
const interruptStarted = Date.now();
const interrupted = await executeImport(
  callB,
  targetBTarget,
  "native",
  "zh",
  entries,
  {
    onProgress: (progress) => {
      if (
        !switched &&
        progress.phase === "batch-done" &&
        progress.batch === 1
      ) {
        switched = true;
        configB.port = closedPort;
      }
    },
  },
);
const interruptElapsed = Date.now() - interruptStarted;
assert.equal(switched, true);
assert.equal(interrupted.interrupted, true);
assert.equal(interrupted.cancelled, false);
assert.equal(interrupted.created, 200);
assert.equal(interrupted.processed, 400);
assert.equal(interrupted.total, 2085);
assert.equal(interrupted.remaining, 1885);
assert(interrupted.failures.length > 0);
const partial = await snapshotTarget(targetBTarget);
assert.equal(partial.noteCount, 200);
configB.port = PORT;
const resumePreview = await previewImport(callB, targetBTarget, entries);
assert.equal(resumePreview.counts.existing, 200);
assert.equal(resumePreview.counts.new, 1885);
const resumeBStarted = Date.now();
const resumed = await executeImport(
  callB,
  targetBTarget,
  "native",
  "zh",
  entries,
);
const resumeBElapsed = Date.now() - resumeBStarted;
assert.equal(resumed.created, 1885);
assert.equal(resumed.interrupted, false);
assert.equal(resumed.remaining, 0);
const finalB = await snapshotTarget(targetBTarget);
assert.equal(finalB.noteCount, 2085);
assert.equal(finalB.cardCount, 2085);
for (const note of partial.notes)
  assert.deepEqual(
    finalB.notes.find((candidate: any) => candidate.id === note.id),
    note,
  );
for (const card of partial.cards)
  assert.deepEqual(
    finalB.cards.find((candidate: any) => candidate.id === card.id),
    card,
  );
const finalPreviewB = await previewImport(callB, targetBTarget, entries);
assert.equal(finalPreviewB.counts.new, 0);
assert.equal(finalPreviewB.counts.existing, 2085);
const finalKeyCounts = await lookup(
  callB,
  targetBTarget,
  b1Entries.map((entry) => "en:" + entry.lemma),
);
assert(
  [...finalKeyCounts.values()].every((ids) => ids.length === 1),
  "interrupted resume produced duplicate Keys",
);
evidence.interruption = {
  closedPort,
  firstRunMs: interruptElapsed,
  firstRunCreated: interrupted.created,
  firstRunProcessed: interrupted.processed,
  firstRunFailures: interrupted.failures.length,
  firstFailure: interrupted.failures[0],
  previewAfterInterruption: resumePreview.counts,
  resumeMs: resumeBElapsed,
  resumeCreated: resumed.created,
  finalPreview: finalPreviewB.counts,
  partialNotesUnchanged: partial.noteCount,
};

// T-05-style read-only scheduling/revlog evidence around the whole run.
evidence.finalCounts = {
  A: (await snapshotTarget(targetATarget)).noteCount,
  B: (await snapshotTarget(targetBTarget)).noteCount,
  C: (await snapshotTarget(targetCTarget)).noteCount,
};
const databaseAfter = sqliteSnapshot();
assert.equal(databaseAfter.scm, databaseBefore.scm);
assert.deepEqual(databaseAfter.revlog, databaseBefore.revlog);
evidence.scm = {
  before: databaseBefore.scm,
  after: databaseAfter.scm,
  revlogRows: databaseAfter.revlog.length,
};
evidence.totalMs = Date.now() - started;
await writeFile(
  `${evidenceDir}/results.json`,
  JSON.stringify(evidence, null, 2),
);
console.log(JSON.stringify(evidence, null, 2));
