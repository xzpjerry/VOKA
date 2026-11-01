// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { extract as extractRaw, highlightRule } from "./reading";
import {
  pageWords,
  pageWordCounts,
  sortPageWords,
  matchesFilter,
} from "./drawer";
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
it("counts repeated recognized Keys and lowercased unrecognized surfaces", () => {
  document.body.innerHTML = "<p>runs ran runs Mxyz mxyz</p>";
  const runEntry = {
    lemma: "run",
    level: "B1",
    GlossNative: "",
    GlossTarget: "",
  };
  const tokens = extractRaw(document.body, (surface) =>
    /^(runs|ran)$/i.test(surface)
      ? { key: "en:run", entry: runEntry }
      : null,
  );
  const counts = pageWordCounts(tokens);
  expect(counts.get("en:run")).toBe(3);
  expect(counts.get("mxyz")).toBe(2);
});
it("keeps first appearance order by default and breaks frequency ties by first appearance", () => {
  document.body.innerHTML =
    "<p>achieve advice afford advice achieve afford afford</p>";
  const tokens = extract(document.body);
  const words = pageWords(tokens);
  const counts = pageWordCounts(tokens);
  const keys = (order: "first" | "frequency") =>
    sortPageWords(words, counts, order).map((token) => token.key);
  expect(keys("first")).toEqual(["en:achieve", "en:advice", "en:afford"]);
  expect(keys("frequency")).toEqual(["en:afford", "en:achieve", "en:advice"]);
});
it("keeps missing dictionary membership independent of highlight state and recalculates filters", () => {
  document.body.innerHTML = "<p>achieve advice mxyz</p>";
  const tokens = extract(document.body);
  const config = { targetLevel: "B1", showAdvanced: false } as const;
  tokens[0].style = highlightRule("B1", config, {
    fields: {},
    cards: [{ cardId: "learning", type: "learning", queue: "learning", intervalDays: 0, dueToday: false }],
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
  expect(tokens.filter((t) => matchesFilter(t, "due"))).toEqual([]);
  expect(tokens.filter((t) => matchesFilter(t, "missing"))).toEqual([
    tokens[2],
  ]);
  tokens[1].style = null;
  expect(tokens.filter((t) => matchesFilter(t, "target"))).toHaveLength(1);
});
it("includes a manually known word in the due filter", () => {
  document.body.innerHTML = "<p>achieve</p>";
  const token = extract(document.body)[0];
  token.state = {
    fields: { ManualStatus: "known" },
    cards: [
      {
        cardId: "known-due",
        type: "review",
        queue: "review",
        intervalDays: 3,
        dueToday: true,
      },
    ],
  };
  expect(matchesFilter(token, "due")).toBe(true);
});
