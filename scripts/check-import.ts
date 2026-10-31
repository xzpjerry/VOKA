import { execFileSync } from "node:child_process";
import { strict as assert } from "node:assert";
import { rpc, checkConnection } from "../src/background/gateway.ts";
import {
  previewImport,
  executeImport,
  CORE_FIELDS,
  DEFAULT_TARGET,
  vokaMeta,
  lookup,
} from "../src/background/import.ts";
import { questionHtml, answerHtml, css } from "../src/data/template.ts";
import { testPack } from "../src/data/test-pack.ts";
const config = { port: 8766, apiKey: "" };
assert.equal(await checkConnection(config), "ok");
const calls: string[] = [];
const call = async (method: string, params = {}, write = false) => {
  calls.push(method);
  return rpc(config, method, params, { sideEffecting: write });
};
// A unique target exercises provisioning without deleting any prototype/user artifacts.
const target = process.argv.includes("--default")
  ? DEFAULT_TARGET
  : {
      noteType: `VOKA Import Acceptance ${Date.now()}`,
      deck: `VOKA::Import Acceptance ${Date.now()}::B1`,
    };
const snapshot = () =>
  JSON.parse(
    execFileSync("python3", ["scripts/anki-snapshot.py"], { encoding: "utf8" }),
  );
if (process.argv.includes("--existing-type"))
  await call(
    "noteTypes.create",
    {
      name: target.noteType,
      fields: CORE_FIELDS.map((name) => ({ name })),
      templates: [{ name: "词卡", questionHtml, answerHtml }],
      css,
      sortField: "Word",
    },
    true,
  );
const before = await previewImport(call, target, testPack.entries);
console.log(
  "target",
  target,
  "first preview",
  before.counts,
  "typeExists",
  before.typeExists,
  "deckExists",
  before.deckExists,
);
const priorDatabase = snapshot();
const priorKeys = before.rows
  .filter((r) => r.state === "existing")
  .map((r) => r.key);
const priorMatches = priorKeys.length
  ? await lookup(call, target, priorKeys)
  : new Map<string, string[]>();
const priorIds = [...priorMatches.values()].flat();
const priorNotes = priorIds.length
  ? await call("notes.getMany", { ids: priorIds })
  : null;
const run = await executeImport(call, target, undefined, undefined, testPack.entries);
assert.deepEqual(run.failures, []);
const importedDatabase = snapshot();
assert.equal(importedDatabase.scm, priorDatabase.scm);
assert.deepEqual(importedDatabase.revlog, priorDatabase.revlog);
for (const row of priorDatabase.cards)
  assert.deepEqual(
    importedDatabase.cards.find((c: any[]) => c[0] === row[0]),
    row,
  );
if (priorNotes)
  assert.deepEqual(await call("notes.getMany", { ids: priorIds }), priorNotes);
console.log(
  "import SCM",
  priorDatabase.scm,
  "→",
  importedDatabase.scm,
  "all pre-existing card scheduling, notes, and review history preserved",
);
const after = await previewImport(call, target, testPack.entries);
assert.equal(after.counts.new, 0);
assert.equal(after.counts.existing, 12);
const type: any = await call("noteTypes.get", {
  noteType: { name: target.noteType },
});
assert.deepEqual(
  type.fields.map((f: any) => f.name),
  CORE_FIELDS,
);
assert.equal(type.sortField, "Word");
assert.equal(type.templates.length, 1);
assert.equal(type.templates[0].name, "词卡");
if (!before.typeExists || process.argv.includes("--existing-type")) {
  assert.equal(type.templates[0].questionHtml, questionHtml);
  assert.equal(type.templates[0].answerHtml, answerHtml);
  assert.equal(type.css, css);
}
const matches = await lookup(
  call,
  target,
  testPack.entries.filter((e) => e.level === "B1").map((e) => "en:" + e.lemma),
);
const ids = [...matches.values()].flat();
const notes: any = await call("notes.getMany", { ids });
for (const item of notes.items) {
  const note = item.result,
    entry = testPack.entries.find((e) => "en:" + e.lemma === note.fields.Key)!;
  assert.deepEqual(Object.keys(note.fields), CORE_FIELDS);
  if (priorKeys.includes(note.fields.Key)) continue;
  assert.equal(note.fields.Word, entry.lemma);
  for (const field of ["GlossNative", "GlossTarget", "Reading"] as const)
    assert.equal(note.fields[field], entry[field]);
  assert.deepEqual(
    JSON.parse(note.fields.VokaMeta),
    JSON.parse(await vokaMeta(entry)),
  );
  assert(note.tags.includes("voka"));
  assert(note.tags.includes("voka::level::B1"));
}
const cardIds = notes.items.flatMap((i: any) => i.result.cardIds);
const cards = await call("cards.getMany", { ids: cardIds });
const databaseBefore = snapshot();
const again = await executeImport(call, target, undefined, undefined, testPack.entries);
assert.equal(again.confirmed.length, 0);
assert.deepEqual(again.failures, []);
const databaseAfter = snapshot();
assert.deepEqual(databaseAfter, databaseBefore);
console.log(
  "existing-type repeat SCM",
  databaseBefore.scm,
  "→",
  databaseAfter.scm,
  "all cards and revlog unchanged; revlog rows",
  databaseAfter.revlog.length,
);
assert.deepEqual(await call("cards.getMany", { ids: cardIds }), cards);
assert.equal((await call("notes.getMany", { ids })).items.length, 12);
console.log(
  "second preview",
  after.counts,
  "confirm disabled:",
  after.counts.new === 0,
  "card count",
  cardIds.length,
  "unchanged after repeat",
);
console.log(
  "Card state checked read-only; no reviews driven. Scheduling/card payload unchanged.",
);
console.log(
  "created notes",
  run.confirmed.length,
  "methods",
  Array.from(new Set(calls)),
);
