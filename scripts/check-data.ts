/** Read-only production B1 preview. Never executes an import. Fixed isolated port. */
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { loadData } from "../src/data/index.ts";
import { previewImport } from "../src/background/import.ts";
import { checkConnection, rpc } from "../src/background/gateway.ts";
const data = await loadData(async (name) =>
  JSON.parse(await readFile(`public/data/${name}.json`, "utf8")),
);
const config = { port: 8766, apiKey: "" };
assert.equal(await checkConnection(config), "ok");
const methods = new Set<string>();
const call = async (method: string, params = {}, write = false) => {
  assert.equal(write, false);
  assert(
    [
      "noteTypes.list",
      "noteTypes.get",
      "decks.list",
      "notes.search",
      "notes.getMany",
    ].includes(method),
  );
  methods.add(method);
  return rpc(config, method, params);
};
const preview = await previewImport(call);
assert.equal(preview.rows.length, 2085);
assert.equal(
  preview.counts.new + preview.counts.existing + preview.counts.conflict,
  2085,
);
console.log(
  JSON.stringify(
    {
      target: preview.target,
      counts: preview.counts,
      version: preview.version,
      methods: [...methods],
    },
    null,
    2,
  ),
);
const missing = data.pack.entries.find(
  (e) => data.lookupEntry(e.lemma).dictionaryStatus === "missing",
);
if (missing) {
  console.log("T-11", missing.lemma, data.lookupEntry(missing.lemma).message);
} else {
  console.log(
    `T-11: no level word without a dictionary entry in ${data.pack.version}; the unlisted-word missing-dictionary UI is covered by check-contexts.ts.`,
  );
}
console.log("B1 preview only; no writes, imports, sync, or review operations.");
