/** Fresh 12-entry import from the real gloss pack into isolated Anki 8766. */
import { strict as assert } from "node:assert";
import puppeteer from "puppeteer";
import { replaceGlossCss } from "../src/background/gloss.ts";
import { readFile } from "node:fs/promises";
import { createData, DATA_VERSION, type Entry } from "../src/data/index.ts";
import {
  contentHash,
  executeImport,
  lookup,
  vokaMeta,
  CORE_FIELDS,
} from "../src/background/import.ts";
import { checkConnection, rpc } from "../src/background/gateway.ts";
const names = [
  "cefrj",
  "octanove",
  "oewn",
  "readings",
  "oewn-readings",
  "morphology",
  "gloss-zh",
];
const packs = await Promise.all(
  names.map(async (name) =>
    JSON.parse(await readFile(`public/data/${name}.json`, "utf8")),
  ),
);
const data = createData(packs);
const native = packs[6];
assert.equal(native.dataVersion, DATA_VERSION);
assert(native.models.includes("deepseek/deepseek-flash"));
assert.equal(native.sourceLemmaCount, 74441);
assert.equal(native.entryCount, Object.keys(native.entries).length);
assert.equal(native.missingCount, native.missingLemmas.length);
assert.equal(native.entryCount + native.missingCount, native.sourceLemmaCount);
console.log(
  "coverage",
  `${native.entryCount}/${native.sourceLemmaCount}`,
  native.complete ? "complete" : "partial",
);
assert.equal(data.lookupEntry("abandon").GlossNative.includes("v."), true);
assert.match(data.lookupEntry("abandon").GlossNative, /[\u4e00-\u9fff]/);
assert.equal(
  data.lookupEntry("vokanonexistentlemma").GlossNative,
  "",
  "missing OEWN word must not invent a native gloss",
);
const entries = data.pack.entries
  .filter((entry: Entry) => entry.level === "B1" && entry.GlossNative)
  .slice(0, 12);
assert.equal(entries.length, 12);
for (const entry of entries)
  assert.match(entry.GlossNative, /[\u4e00-\u9fff]/);

const config = { port: 8766, apiKey: "" };
assert.equal(await checkConnection(config), "ok");
const methods: string[] = [];
const call = async (method: string, params = {}, write = false) => {
  methods.push(method);
  return rpc(config, method, params, { sideEffecting: write });
};
const stamp = Date.now();
const target = {
  noteType: `VOKA Gloss Acceptance ${stamp}`,
  deck: `VOKA::Gloss Acceptance ${stamp}::B1`,
};
const run = await executeImport(call, target, "native", "zh", entries);
assert.deepEqual(run.failures, []);
assert.equal(run.confirmed.length, 12);
const matches = await lookup(
  call,
  target,
  entries.map((entry: Entry) => "en:" + entry.lemma),
);
const ids = [...matches.values()].flat();
assert.equal(ids.length, 12);
const notes: any = await call("notes.getMany", { ids });
const rendered = [];
const browser = await puppeteer.launch({ headless: true });
try {
const page = await browser.newPage();
for (const item of notes.items) {
  assert(!item.error, JSON.stringify(item.error));
  const note = item.result;
  const entry = entries.find(
    (candidate: Entry) => "en:" + candidate.lemma === note.fields.Key,
  )!;
  assert(entry, note.fields.Key);
  assert.deepEqual(Object.keys(note.fields), CORE_FIELDS);
  assert.equal(note.fields.GlossNative, entry.GlossNative);
  assert.equal(note.fields.GlossTarget, entry.GlossTarget);
  assert.match(note.fields.GlossNative, /[\u4e00-\u9fff]/);
  const meta = JSON.parse(note.fields.VokaMeta);
  assert.equal(meta.data, DATA_VERSION);
  assert.equal(meta.hashes.GlossNative, await contentHash(entry.GlossNative));
  assert.deepEqual(meta, JSON.parse(await vokaMeta(entry)));
  assert(note.tags.includes("voka"));
  assert(note.tags.includes("voka::level::B1"));
  if (rendered.length < 2) {
    const cardId = note.cardIds[0];
    const card = await call("cards.render", { id: cardId });
    assert(card.answerHtml.includes(entry.GlossNative), "native gloss missing in card");
    for (const mode of ["native", "target"] as const) {
      await page.setContent(`${card.answerHtml}<style>${replaceGlossCss(card.css, mode)}</style>`);
      const state = await page.evaluate(() => Object.fromEntries(
        ["native", "target"].map((language) => {
          const el = document.querySelector(`.gloss-${language}`)!;
          return [language, { display: getComputedStyle(el).display, text: el.textContent }];
        }),
      ));
      assert.equal(state[mode].display, "block");
      assert.equal(state[mode === "native" ? "target" : "native"].display, "none");
    }
    // Exercise both missing-field fallbacks using the actual rendered template.
    for (const missing of ["native", "target"] as const) {
      await page.setContent(`${card.answerHtml}<style>${replaceGlossCss(card.css, missing)}</style>`);
      await page.evaluate((language) => {
        document.querySelector(`.gloss-${language}`)!.textContent = "";
        const marker = document.createElement("span");
        marker.className = `miss-${language}`;
        document.querySelector(".gloss-native")!.before(marker);
      }, missing);
      const fallback = missing === "native" ? "target" : "native";
      assert.equal(await page.$eval(`.gloss-${fallback}`, (el) => getComputedStyle(el).display), "block");
    }
    rendered.push({ key: note.fields.Key, glossNative: entry.GlossNative, cardId });
  }
}
const beforeRepeat = await call("notes.getMany", { ids });
const methodOffset = methods.length;
const repeated = await executeImport(call, target, "native", "zh", entries);
assert.deepEqual(repeated.confirmed, []);
assert.equal(repeated.total, 0);
assert(!methods.slice(methodOffset).some((method) => /create|update|validate/.test(method)));
assert.deepEqual(await call("notes.getMany", { ids }), beforeRepeat);
} finally {
  await browser.close();
}
console.log(
  JSON.stringify(
    {
      port: 8766,
      dataVersion: DATA_VERSION,
      pack: {
        entryCount: native.entryCount,
        sourceLemmaCount: native.sourceLemmaCount,
        missingCount: native.missingCount,
        model: native.model,
        promptSha256: native.promptSha256,
      },
      target,
      confirmed: run.confirmed,
      rendered,
      methods: [...new Set(methods)],
      note: "fresh synthetic target; no existing notes edited; no schedules or reviews changed",
    },
    null,
    2,
  ),
);
