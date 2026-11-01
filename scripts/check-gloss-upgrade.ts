/** T-29 and Chrome UI acceptance. Writes ONLY isolated 8766; retains named fixtures. */
import puppeteer from "puppeteer";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { rpc, checkConnection } from "../src/background/gateway";
import {
  executeImport,
  lookup,
  vokaMeta,
  contentHash,
} from "../src/background/import";
import { DATA_VERSION } from "../src/data";
const config = { port: 8766, apiKey: "" };
assert.equal(await checkConnection(config), "ok");
const call = (method: string, params = {}, write = false): Promise<any> =>
  rpc(config, method, params, { sideEffecting: write }) as Promise<any>;
const stamp = Date.now();
const target = {
  noteType: `VOKA Gloss Upgrade Test ${stamp}`,
  deck: `VOKA::Gloss Upgrade Test ${stamp}::B1`,
};
const entries = ["achieve", "benefit"].map((lemma) => ({
  lemma,
  level: "B1",
  GlossNative: "",
  GlossTarget: "old test meaning",
  Reading: "old test reading",
}));
const created = await executeImport(call, target, "native", "zh", entries);
assert.equal(created.created, 2);
const ids = [
  ...(
    await lookup(
      call,
      target,
      entries.map((e) => "en:" + e.lemma),
    )
  ).values(),
].flat();
const read = async () =>
  (await call("notes.getMany", { ids })).items.map((i: any) => i.result);
let notes = await read();
for (const note of notes) {
  const entry = entries.find((e) => note.fields.Key === "en:" + e.lemma)!;
  const meta = {
    ...JSON.parse(await vokaMeta(entry, "en-test-old")),
    pin: "keep-pin",
    extra: { test: stamp },
    hashes: {
      ...JSON.parse(await vokaMeta(entry)).hashes,
      pinnedContext: "keep-pinned-hash",
    },
  };
  await call(
    "notes.update",
    {
      id: note.id,
      patch: {
        fields: {
          Context1: "We <b>achieve</b> our goals.",
          Source1: "test.invalid · Fixture",
          ManualStatus: "known",
          Audio: "[sound:test.mp3]",
          VokaMeta: JSON.stringify(meta),
        },
      },
    },
    true,
  );
}
await call(
  "notes.update",
  { id: ids[1], patch: { fields: { GlossNative: "my handmade meaning" } } },
  true,
);
async function collectionSnapshot() {
  const result: Record<string, any[]> = { notes: [], cards: [] };
  for (const entity of ["notes", "cards"]) {
    let cursor: string | undefined;
    do {
      const page = await call(`${entity}.search`, {
        query: "",
        limit: 1000,
        ...(cursor ? { cursor } : {}),
      });
      for (let start = 0; start < page.ids.length; start += 100) {
        const batch = await call(`${entity}.getMany`, {
          ids: page.ids.slice(start, start + 100),
        });
        for (const item of batch.items) {
          assert(!item.error);
          result[entity].push(item.result);
        }
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    result[entity].sort((a, b) => a.id.localeCompare(b.id));
  }
  return result;
}
const before = await collectionSnapshot();
console.log(
  "Fixture and collection snapshot ready",
  before.notes.length,
  before.cards.length,
);
const evidence = "docs/research/gloss-upgrade-evidence";
await mkdir(evidence, { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), "voka-gloss-upgrade-"));
const extension = join(scratch, "extension");
await cp(resolve("dist"), extension, { recursive: true });
const bg = join(extension, "background.js");
await writeFile(
  bg,
  'chrome.storage.local.set({port:8766,apiKey:"",nativeLanguage:"zh"});\n' +
    (await readFile(bg, "utf8")),
);
const server = createServer((_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(
    '<title>Gloss upgrade acceptance</title><p style="font:24px Georgia;padding:48px">We achieve our goals and benefit from reading.</p>',
  );
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
let browser;
try {
  browser = await puppeteer.launch({
    headless: false,
    enableExtensions: [extension],
    args: ["--no-first-run", "--lang=zh-CN"],
  });
  const worker = (await (
    await browser.waitForTarget((t) => t.type() === "service_worker")
  ).worker())!;
  console.log("Browser worker ready");
  const extensionId = worker.url().split("/")[2];
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 1000 });
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  page.on("pageerror", (error) => console.error("PAGE ERROR", error));
  page.on("console", (message) => console.log("BROWSER", message.text()));
  await page
    .waitForFunction(
      () => document.querySelector("#status")?.textContent === "已连接",
      { polling: 100 },
    )
    .catch(async (error) => {
      console.error(await page.$eval("body", (e) => e.textContent));
      throw error;
    });
  console.log("Options connected");
  assert.equal(
    await page.$eval("#checkUpgrade", (e: HTMLButtonElement) => e.disabled),
    false,
  );
  await page.$eval("#preview", (e: HTMLElement) => e.click());
  await page.waitForFunction(
    () =>
      document
        .querySelector("#importUpgrade")
        ?.textContent?.includes("张词卡的释义有更新"),
    { timeout: 120000, polling: 100 },
  );
  await page.$eval("#importUpgrade", (e) => e.scrollIntoView());
  await page.screenshot({ path: `${evidence}/import-preview.png` });
  console.log("Import summary checked");
  await page.$eval("#checkUpgrade", (e: HTMLElement) => e.click());
  await page.waitForFunction(
    () => !!document.querySelector("#confirmUpgrade"),
    { timeout: 120000, polling: 100 },
  );
  const groups = await page.$$eval("#upgradePreview details > summary", (es) =>
    es.map((e) => e.textContent),
  );
  assert.equal(groups.length, 2);
  const checked = await page.$$eval(
    "#upgradePreview input",
    (es, ids) =>
      es
        .filter((e: any) => ids.includes(e.dataset.id))
        .map((e: any) => ({ id: e.dataset.id, checked: e.checked })),
    ids,
  );
  assert.equal(checked.find((i) => i.id === ids[0])?.checked, true);
  assert.equal(checked.find((i) => i.id === ids[1])?.checked, false);
  assert.deepEqual(
    await collectionSnapshot(),
    before,
    "ALL fields/tags/cards unchanged before confirm",
  );
  await page.$eval("#updates", (e) => e.scrollIntoView());
  // Open the unedited group and keep just our fixture selected, including among real upgrades.
  await page.evaluate((ids) => {
    document
      .querySelectorAll<HTMLInputElement>("#upgradePreview input")
      .forEach((i) => {
        i.checked = i.dataset.id === ids[0];
      });
    const groups = document.querySelectorAll<HTMLDetailsElement>(
      "#upgradePreview details",
    );
    groups.forEach((g) => {
      g.open = true;
    });
    document
      .querySelector<HTMLInputElement>(
        `#upgradePreview input[data-id="${ids[1]}"]`,
      )
      ?.scrollIntoView();
  }, ids);
  await page.screenshot({ path: `${evidence}/edited-default-keep.png` });
  const reading = await browser.newPage();
  await reading.goto(base);
  const tabId = await worker.evaluate(
    async (base) =>
      (await chrome.tabs.query({})).find((t) => t.url?.startsWith(base))!.id!,
    base,
  );
  await worker.evaluate(
    (id) =>
      chrome.scripting.executeScript({
        target: { tabId: id },
        files: ["content.js"],
      }),
    tabId,
  );
  await reading.waitForFunction(
    () => {
      const root = document.querySelector("#voka-drawer")?.shadowRoot;
      const link = root?.querySelector<HTMLAnchorElement>('a[target="_blank"]');
      return link && !link.hidden;
    },
    { timeout: 120000, polling: 100 },
  );
  await reading.screenshot({ path: `${evidence}/drawer-notice.png` });
  await page.$eval("#confirmUpgrade", (e: HTMLElement) => e.click());
  await page.waitForFunction(
    () =>
      document
        .querySelector("#upgradeStatus")
        ?.textContent?.includes("updated"),
    { timeout: 120000, polling: 100 },
  );
  notes = await read();
  const meta = JSON.parse(notes[0].fields.VokaMeta);
  assert.equal(meta.data, DATA_VERSION);
  assert.equal(meta.pin, "keep-pin");
  assert.equal(meta.hashes.pinnedContext, "keep-pinned-hash");
  assert.equal(meta.extra.test, stamp);
  for (const field of ["GlossNative", "GlossTarget", "Reading"])
    assert.equal(meta.hashes[field], await contentHash(notes[0].fields[field]));
  const afterFirst = await collectionSnapshot();
  assert.deepEqual(
    afterFirst.cards,
    before.cards,
    "all card due/ivl/reps and other review fields unchanged",
  );
  const omitChanged = (snapshot: typeof before) =>
    snapshot.notes.map((n) =>
      ids[0] === n.id
        ? {
            ...n,
            fields: Object.fromEntries(
              Object.entries(n.fields).filter(
                ([k]) =>
                  ![
                    "GlossNative",
                    "GlossTarget",
                    "Reading",
                    "VokaMeta",
                  ].includes(k),
              ),
            ),
            modifiedAt: "updated",
          }
        : n,
    );
  assert.deepEqual(omitChanged(afterFirst), omitChanged(before));
  assert.deepEqual(
    notes[1],
    before.notes.find((n) => n.id === ids[1]),
    "kept edited note untouched",
  );
  await reading.waitForFunction(() => {
    const link = document.querySelector("#voka-drawer")?.shadowRoot?.querySelector<HTMLAnchorElement>('a[target="_blank"]');
    return link?.hidden;
  }, { timeout: 120000, polling: 100 });
  await page.$eval("#checkUpgrade", (e: HTMLElement) => e.click());
  await page.waitForFunction(() => !!document.querySelector<HTMLButtonElement>("#confirmUpgrade")?.disabled,
    { timeout: 120000, polling: 100 });
  for (const id of ids) assert.equal(await page.$(`input[data-id="${id}"]`), null);
  await page.waitForFunction(() => document.querySelector("#importUpgrade")?.textContent === "",
    { timeout: 120000, polling: 100 });
  const kept = await worker.evaluate(async () => (await chrome.storage.local.get("upgradeKept")).upgradeKept);
  assert.equal(kept[ids[1]], DATA_VERSION);
  await page.$eval("#resetUpgradeKept", (e: HTMLElement) => e.click());
  await page.waitForFunction(
    (id) => !!document.querySelector(`#upgradePreview input[data-id="${id}"]`),
    { timeout: 120000, polling: 100 },
    ids[1],
  );
  assert.equal(
    await page.$(`input[data-id="${ids[0]}"]`),
    null,
    "already upgraded note omitted",
  );
  await page.evaluate((id) => {
    document
      .querySelectorAll<HTMLInputElement>("#upgradePreview input")
      .forEach((i) => {
        i.checked = i.dataset.id === id;
      });
  }, ids[1]);
  await page.$eval("#confirmUpgrade", (e: HTMLElement) => e.click());
  await page.waitForFunction(
    () =>
      document
        .querySelector("#upgradeStatus")
        ?.textContent?.includes("updated"),
    { timeout: 120000, polling: 100 },
  );
  const afterBoth = await read();
  assert.equal(JSON.parse(afterBoth[1].fields.VokaMeta).data, DATA_VERSION);
  assert.notEqual(afterBoth[1].fields.GlossNative, "my handmade meaning");
  await page.$eval("#checkUpgrade", (e: HTMLElement) => e.click());
  await page.waitForFunction(
    () => !!document.querySelector("#confirmUpgrade"),
    { timeout: 120000, polling: 100 },
  );
  for (const id of ids)
    assert.equal(await page.$(`input[data-id="${id}"]`), null);
  await writeFile(
    `${evidence}/result.json`,
    JSON.stringify(
      {
        target,
        ids,
        groups,
        checked,
        collectionNotes: before.notes.length,
        collectionCards: before.cards.length,
        verified: [
          "preview read only entire collection",
          "two groups/defaults",
          "kept note byte-for-byte untouched including modification time",
          "confirmed keeps excluded from fresh preview, import-preview count, and drawer notice",
          "settings reset restores kept updates",
          "selected updates only",
          "metadata pin/extra/hash preservation",
          "all card scheduling unchanged",
          "idempotent fixture rerun",
          "drawer/settings/import preview in Chrome for Testing",
        ],
        notVerified: [
          "AnkiMobile/AnkiDroid",
          "real transport interruption or partial failure (unit tests cover)",
          "concurrent edits from Anki during an in-flight write",
        ],
      },
      null,
      2,
    ),
  );
  console.log("PASS T-29", target, ids, "all collection notes/cards compared");
} finally {
  await browser?.close();
  await new Promise<void>((r) => server.close(() => r()));
  await rm(scratch, { recursive: true, force: true });
}
