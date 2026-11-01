// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { extract as extractRaw, highlightRule } from "./reading";
import { pageWords, matchesFilter } from "./drawer";
import { readFileSync } from "node:fs";
import { createData } from "./data";
const data = createData(
  [
    "cefrj",
    "octanove",
    "oewn",
    "readings",
    "oewn-readings",
    "morphology",
    "gloss-zh",
  "gloss-leveled",
  ].map(
    (name) => JSON.parse(readFileSync(`public/data/${name}.json`, "utf8")),
  ),
);
const extract = (root: Node) =>
  extractRaw(root, (surface) => {
    const entry = data.lookupEntry(data.lemmaCandidates(surface)[0] ?? surface);
    return { key: `en:${entry.lemma}`, entry };
  });
it("deduplicates inflected Keys, restores document order, and retains surface forms for missing entries", () => {
  document.body.innerHTML = "<p>achieved achieve Mxyz mxyz afford</p>";
  const tokens = extract(document.body);
  const words = pageWords([...tokens].reverse());
  expect(words.map((t) => t.key)).toEqual([
    "en:achieve",
    "en:mxyz",
    "en:afford",
  ]);
  expect(words[0].range.toString()).toBe("achieved");
  expect(words[1].range.toString()).toBe("Mxyz");
});
it("keeps missing dictionary membership independent of highlight state and recalculates filters", () => {
  document.body.innerHTML = "<p>achieve advice mxyz</p>";
  const tokens = extract(document.body);
  const config = { targetLevel: "B1", showAdvanced: false } as const;
  tokens[0].style = highlightRule("B1", config, {
    fields: {},
    cards: [{ type: "learning", queue: "learning", intervalDays: 0 }],
  });
  tokens[1].style = highlightRule("A2", config, {
    fields: { ManualStatus: "unknown" },
    cards: [],
  });
  tokens[2].style = "target";
  // Dictionary membership is independent of available note/gloss text.
  tokens[0].entry.GlossTarget = "";
  tokens[2].entry.GlossTarget = "user-authored definition";
  expect(tokens.filter((t) => matchesFilter(t, "target"))).toHaveLength(2);
  expect(tokens.filter((t) => matchesFilter(t, "learning"))).toHaveLength(1);
  expect(tokens.filter((t) => matchesFilter(t, "missing"))).toEqual([
    tokens[2],
  ]);
  tokens[1].style = null;
  expect(tokens.filter((t) => matchesFilter(t, "target"))).toHaveLength(1);
});
