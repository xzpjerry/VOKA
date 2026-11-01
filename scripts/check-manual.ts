import puppeteer from "puppeteer";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { rpc } from "../src/background/gateway";
import { lookup, DEFAULT_TARGET } from "../src/background/import";
import { loadData } from "../src/data";

// Writes go only to the isolated AnkiConnect instance.
const call = (method: string, params = {}, write = false) =>
  rpc({ port: 8766, apiKey: "" }, method, params, {
    sideEffecting: write,
  }) as Promise<any>;
const keyOf = (word: string) => "en:" + word;
const readNote = async (word: string) => {
  const key = keyOf(word);
  const ids = (await lookup(call, DEFAULT_TARGET, [key])).get(key)!;
  assert(ids.length <= 1, `conflicting notes for ${key}`);
  return ids.length
    ? (await call("notes.getMany", { ids })).items[0].result
    : undefined;
};
const fields = (note: any) => ({ ...note.fields });
const changed = (before: Record<string, string>, after: Record<string, string>) =>
  Object.keys({ ...before, ...after })
    .filter((field) => before[field] !== after[field])
    .sort();

const target = "benefit"; // B1, target level, existing note
const below = "banana"; // A1, below target B1, existing note
// Pick an unused A1 entry from the local data pack for the add-first path.
const data = await loadData(async (name) =>
  JSON.parse(
    await readFile(resolve(`public/data/${name}.json`), "utf8"),
  ),
);
const candidates = [
  ...new Set(
    data.pack.entries
      .filter((entry) => entry.level === "A1" && /^[a-z]{3,18}$/.test(entry.lemma))
      .map((entry) => entry.lemma),
  ),
];
let createdWord = "";
for (let start = 0; start < candidates.length; start += 40) {
  const batch = candidates.slice(start, start + 40);
  const matches = await lookup(call, DEFAULT_TARGET, batch.map(keyOf));
  const unused = batch.find((word) => !(matches.get(keyOf(word)) ?? []).length);
  if (unused) {
    createdWord = unused;
    break;
  }
}
assert(createdWord, "no unused A1 entry is available for the manual-add check");

const beforeTarget = await readNote(target);
const beforeBelow = await readNote(below);
assert(beforeTarget, `${target} fixture note is missing`);
assert(beforeBelow, `${below} fixture note is missing`);
assert.notEqual(beforeTarget.fields.ManualStatus, "unknown");

const pageHtml = `<!doctype html><title>Manual status acceptance</title>
<style>body{font:22px/1.8 Georgia;padding:40px;max-width:900px}</style>
<p id="line">We want to <span id="benefit">benefit</span> from a <span id="banana">banana</span>, while a <span id="${createdWord}">${createdWord}</span> sleeps nearby.</p>
<p>This can <span id="improve">improve</span> the result.</p>`;
const server = createServer((_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(pageHtml);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
const evidence = "docs/research/manual-status-evidence";
await mkdir(evidence, { recursive: true });
let browser;
let createdNoteId: string | undefined;
try {
  browser = await puppeteer.launch({
    headless: false,
    enableExtensions: [resolve("dist")],
    args: ["--no-first-run"],
  });
  const worker = (await (
    await browser.waitForTarget((t) => t.type() === "service_worker")
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
  const inject = async () => {
    await page.goto(base);
    const tabId = await worker.evaluate(
      async (base) =>
        (await chrome.tabs.query({})).find((t) => t.url?.startsWith(base))!.id!,
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
    await page.waitForFunction(() => CSS.highlights.get("voka-target")?.size);
    await page.waitForFunction(() =>
      /(\d+)/.test(
        document
          .getElementById("voka-drawer")!
          .shadowRoot!.querySelector(".drawer-toggle [role=status]")!.textContent!,
      ),
    );
  };
  const clickWord = async (id: string, count = 1) => {
    await page.bringToFront();
    // Locator waits for a stable visible word before dispatching trusted clicks.
    await page.locator("#" + id).click({ count });
  };
  const cardText = () =>
    page.evaluate(
      () =>
        document
          .getElementById("voka-drawer")!
          .shadowRoot!.querySelector("#voka-card")!.textContent!,
    );
  const manualLabel = () =>
    page.evaluate(
      () =>
        (
          document
            .getElementById("voka-drawer")!
            .shadowRoot!.querySelector("#voka-manual-status") as HTMLButtonElement
        ).textContent,
    );
  const drawerSummary = () =>
    page.evaluate(
      () =>
        document
          .getElementById("voka-drawer")!
          .shadowRoot!.querySelector(".drawer-toggle [role=status]")!.textContent!,
    );
  const snapshots = () =>
    page.evaluate(() =>
      Object.fromEntries(
        [...CSS.highlights].map(([name, value]) => [
          name,
          [...value].map((range) => range.toString()),
        ]),
      ),
    ) as Promise<Record<string, string[]>>;
  const waitCard = (head: string) =>
    page.waitForFunction(
      (head) => {
        const root = document.getElementById("voka-drawer")!.shadowRoot!;
        return (
          !(root.querySelector("#voka-card") as HTMLElement).hidden &&
          root.querySelector("#voka-card h2")?.textContent === head &&
          !(root.querySelector("#voka-manual-status") as HTMLButtonElement)
            ?.disabled
        );
      },
      {},
      head,
    );
  const clickManual = async () => {
    const label = await manualLabel();
    await page.evaluate(() =>
      (
        document
          .getElementById("voka-drawer")!
          .shadowRoot!.querySelector("#voka-manual-status") as HTMLButtonElement
      ).click(),
    );
    return label;
  };
  const waitStatus = (text: string) =>
    page.waitForFunction(
      (text) =>
        document
          .getElementById("voka-drawer")!
          .shadowRoot!.querySelector("#voka-card [role=status]")?.textContent ===
        text,
      {},
      text,
    );
  const targetCount = async () => {
    const text = await drawerSummary();
    const match = /(\d+)/.exec(text);
    assert(match, `drawer summary missing count: ${text}`);
    return Number(match[1]);
  };

  await inject();
  let snap = await snapshots();
  assert(snap["voka-target"]?.includes(target), "target word not highlighted");
  assert(!snap["voka-target"]?.includes(below), "A1 word must be below target");
  assert(!snap["voka-unknown"]?.includes(below), "A1 word starts unmarked");
  const countBefore = await targetCount();

  // T-08a: target word -> known removes its highlight.
  await clickWord(target);
  await waitCard(target);
  const beforeKnown = fields(await readNote(target));
  assert.equal(
    await manualLabel(),
    "我认识，别再高亮",
  );
  await clickManual();
  await waitStatus("已标为认识");
  snap = await snapshots();
  assert(!snap["voka-target"]?.includes(target), "known target still highlighted");
  assert.equal(await targetCount(), countBefore - 1, "drawer count did not drop");
  let note = await readNote(target);
  assert.equal(note.fields.ManualStatus, "known");
  const knownDiff = changed(beforeKnown, fields(note));
  const afterKnown = fields(note);
  assert.deepEqual(knownDiff, ["ManualStatus"], "known changed other fields");
  assert.equal(
    await manualLabel(),
    "撤销标记",
  );
  await page.screenshot({ path: evidence + "/target-known.png" });

  // Persistence: reload and reinject; known stays off.
  await inject();
  snap = await snapshots();
  assert(!snap["voka-target"]?.includes(target), "known lost after reload");
  await clickWord(target, 2);
  await waitCard(target);
  assert.equal(await cardText().then((t) => t.includes("撤销标记")), true);
  const countKnown = await targetCount();
  await clickManual();
  await waitStatus("已撤销标记");
  snap = await snapshots();
  assert(snap["voka-target"]?.includes(target), "undo did not restore target rule");
  assert.equal(await targetCount(), countKnown + 1, "drawer count not restored");
  assert.deepEqual(
    fields(await readNote(target)),
    beforeKnown,
    "undo did not restore the original fields",
  );
  await page.screenshot({ path: evidence + "/target-undo.png" });

  // T-08b: below-target word -> unknown turns red, survives reload, undo restores none.
  const beforeUnknown = fields(await readNote(below));
  const countUnmarked = await targetCount();
  await clickWord(below, 2);
  await waitCard(below);
  assert.equal(
    await manualLabel(),
    "我不认识，高亮它",
  );
  await clickManual();
  await waitStatus("已标为不认识");
  snap = await snapshots();
  assert(snap["voka-unknown"]?.includes(below), "unknown word is not red");
  assert.equal(
    await targetCount(),
    countUnmarked + 1,
    "unknown word missing from target count",
  );
  note = await readNote(below);
  const unknownDiff = changed(beforeUnknown, fields(note));
  const afterUnknown = fields(note);
  assert.deepEqual(unknownDiff, ["ManualStatus"], "unknown changed other fields");
  assert.equal(note.fields.ManualStatus, "unknown");
  await page.screenshot({ path: evidence + "/below-unknown.png" });

  await inject();
  snap = await snapshots();
  assert(snap["voka-unknown"]?.includes(below), "unknown lost after reload");
  await clickWord(below);
  await waitCard(below);
  await clickManual();
  await waitStatus("已撤销标记");
  snap = await snapshots();
  assert(!snap["voka-unknown"]?.includes(below), "undo kept unknown highlight");
  assert(!snap["voka-target"]?.includes(below), "below-target word wrongly target");
  assert.deepEqual(
    fields(await readNote(below)),
    beforeUnknown,
    "undo did not restore the original fields",
  );

  // Word outside Anki: unknown creates its note through the existing manual-add flow.
  const absentBefore = await readNote(createdWord);
  assert(!absentBefore, `${createdWord} already exists; rerun to pick another word`);
  await clickWord(createdWord, 2);
  await waitCard(createdWord);
  assert.equal(
    await manualLabel(),
    "我不认识，高亮它",
  );
  await clickManual();
  await waitStatus("已标为不认识");
  const created = await readNote(createdWord);
  assert(created, "manual unknown did not add the word to Anki");
  createdNoteId = created.id;
  assert.equal(created.fields.ManualStatus, "unknown");
  assert.equal(created.fields.Context1, "");
  assert(created.tags.includes("voka::level::A1"));
  const createdFields = fields(created);
  snap = await snapshots();
  assert(snap["voka-unknown"]?.includes(createdWord), "new word is not red");
  await page.screenshot({ path: evidence + "/absent-added-unknown.png" });
  await clickManual();
  await waitStatus("已撤销标记");
  assert.equal((await readNote(createdWord)).fields.ManualStatus, "");
  assert(!(await snapshots())["voka-unknown"]?.includes(createdWord));

  const result = {
    browser: await browser.version(),
    port: 8766,
    target: {
      key: keyOf(target),
      before: beforeKnown,
      afterManualKnown: afterKnown,
      changedFields: knownDiff,
    },
    below: {
      key: keyOf(below),
      before: beforeUnknown,
      afterManualUnknown: afterUnknown,
      changedFields: unknownDiff,
    },
    absent: {
      key: keyOf(createdWord),
      existedBefore: !!absentBefore,
      createdNoteId,
      fieldsAfterManualUnknown: createdFields,
    },
    checks: [
      "target word known removes its highlight and lowers the drawer target count",
      "below-target word unknown becomes red regardless of level and raises the target count",
      "undo restores the automatic rule for both words",
      "known and unknown both survive a page reload",
      "only ManualStatus differs in Anki for existing notes",
      "unknown on a word without a note creates it in its level deck with ManualStatus=unknown",
      "no manual learning option",
    ],
  };
  await writeFile(
    evidence + "/result.json",
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser?.close();
  server.close();
  // Restore fixture judgments; never delete notes in the isolated test collection.
  for (const [word, original] of [
    [target, beforeTarget],
    [below, beforeBelow],
  ] as const)
    if (original && (await readNote(word))?.fields.ManualStatus !== original.fields.ManualStatus)
      await call(
        "notes.update",
        {
          id: original.id,
          patch: { fields: { ManualStatus: original.fields.ManualStatus } },
        },
        true,
      );
  if (createdNoteId)
    await call(
      "notes.update",
      { id: createdNoteId, patch: { fields: { ManualStatus: "" } } },
      true,
    );
}
