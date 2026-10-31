/**
 * TEST-ONLY cleanup for scripts/check-level-import.ts artifacts.
 *
 * Deletes only the throwaway note types, decks, and the one manual A2 note
 * recorded in docs/research/level-import-evidence/artifacts.json. It never
 * runs from product code and refuses names outside the acceptance prefix.
 */
import { strict as assert } from "node:assert";
import { readFile, writeFile } from "node:fs/promises";
import { checkConnection, rpc } from "../src/background/gateway.ts";

const manifestPath =
  process.argv[2] ?? "docs/research/level-import-evidence/artifacts.json";
const config = { port: 8766, apiKey: "" };
assert.equal(await checkConnection(config), "ok");
const call = async (method: string, params: any = {}, write = false) =>
  rpc(config, method, params, { sideEffecting: write });

const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
  targets: { noteType: string; deckPrefix: string; levels?: string[] }[];
  manualNotes?: string[];
};
assert(Array.isArray(manifest.targets), "manifest has no targets");
const removed = {
  notes: 0,
  decks: [] as string[],
  noteTypes: [] as string[],
  manualNotes: 0,
};
async function allIds(query: string, method = "notes.search") {
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
async function deleteNotes(ids: string[]) {
  for (let start = 0; start < ids.length; start += 100) {
    const result = await call(
      "notes.delete",
      { ids: ids.slice(start, start + 100) },
      true,
    );
    for (const item of result.items)
      assert(!item.error, `notes.delete: ${JSON.stringify(item.error)}`);
  }
  removed.notes += ids.length;
}
for (const target of manifest.targets) {
  assert(
    target.noteType.startsWith("VOKA Level Import Acceptance") &&
      target.deckPrefix.startsWith("VOKA::Level Import Acceptance"),
    `refusing to clean unexpected target ${target.noteType} / ${target.deckPrefix}`,
  );
  const noteIds = await allIds(`note:"${target.noteType}"`);
  await deleteNotes(noteIds);
  const decks: { name: string }[] = await call("decks.list");
  const matching = decks
    .map((deck) => deck.name)
    .filter(
      (name) =>
        name === target.deckPrefix || name.startsWith(target.deckPrefix + "::"),
    )
    .sort((a, b) => b.length - a.length);
  if (matching.length) {
    const result = await call(
      "decks.delete",
      { decks: matching.map((name) => ({ name })), deleteCards: true },
      true,
    );
    for (const item of result.items)
      assert(!item.error, `decks.delete: ${JSON.stringify(item.error)}`);
    removed.decks.push(...matching);
  }
  const types: { name: string }[] = await call("noteTypes.list");
  if (types.some((type) => type.name === target.noteType)) {
    const result = await call(
      "noteTypes.deleteUnused",
      { noteTypes: [{ name: target.noteType }] },
      true,
    );
    for (const item of result.items)
      assert(
        !item.error,
        `noteTypes.deleteUnused: ${JSON.stringify(item.error)}`,
      );
    removed.noteTypes.push(target.noteType);
  }
  assert.equal((await allIds(`note:"${target.noteType}"`)).length, 0);
  assert(
    !(await call("decks.list")).some(
      (deck: { name: string }) =>
        deck.name === target.deckPrefix ||
        deck.name.startsWith(target.deckPrefix + "::"),
    ),
  );
  assert(
    !(await call("noteTypes.list")).some(
      (type: { name: string }) => type.name === target.noteType,
    ),
  );
}
const manual = (manifest.manualNotes ?? []).filter((id) =>
  /^[1-9][0-9]{0,18}$/.test(id),
);
if (manual.length) {
  await deleteNotes(manual);
  removed.manualNotes = manual.length;
}
manifest.cleanedAt = new Date().toISOString();
await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ manifestPath, removed }, null, 2));
