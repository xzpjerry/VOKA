import { it, expect } from "vitest";
import {
  sentenceAt,
  normalizeSentence,
  contextState,
  contextFields,
  addContext,
  togglePin,
  orderedContexts,
  defaultReplacement,
  sentenceHash,
  contextSource,
} from "./contexts";
const plain = (s: string) => s.replace(/<[^>]*>/g, "");
const context = async (text: string) => ({
  html: text,
  text,
  source: "example.com",
  hash: await sentenceHash(text),
});
it("selects the target sentence and bolds its encountered inflection, not its lemma", () => {
  const text =
    "Before this happened. They achieved a difficult goal. Then they left.";
  expect(sentenceAt(text, text.indexOf("achieved"), 8)).toEqual({
    text: "They achieved a difficult goal.",
    html: "They <b>achieved</b> a difficult goal.",
  });
});
it.each([
  "Enjoy fresh apple",
  "A healthy apple snack",
  "Fresh apple for everyone",
])("keeps punctuation-free heading/list/cell text: %s", (text) => {
  expect(sentenceAt(text, text.indexOf("apple"), 5).text).toBe(text);
});
it("removes footnotes, escapes HTML, refuses short sentences and windows long text", () => {
  const text = "They [1] achieved¹ a goal & celebrated.";
  expect(sentenceAt(text, text.indexOf("achieved"), 8).html).toBe(
    "They  <b>achieved</b> a goal &amp; celebrated.",
  );
  expect(() => sentenceAt("achieved it.", 0, 8)).toThrow("这句太短");
  const long =
    "A distant start " +
    "many words ".repeat(40) +
    "achieved" +
    " many words".repeat(40) +
    ".";
  const result = sentenceAt(long, long.indexOf("achieved"), 8);
  expect(result.text.length).toBeLessThanOrEqual(300);
  expect(result.text.startsWith("…")).toBe(true);
  expect(result.text.endsWith("…")).toBe(true);
  expect(result.html).toContain("<b>achieved</b>");
});
it("normalizes case, whitespace and edge punctuation for dedupe", () => {
  expect(normalizeSentence(" “They  ACHIEVED a goal!” ")).toBe(
    normalizeSentence("they achieved a goal"),
  );
  expect(normalizeSentence("They[1] achieved¹ a goal.")).toBe(
    "they achieved a goal",
  );
});
it("orders newest first, preserves one pin and selects oldest unpinned replacement", async () => {
  let s = await contextState({}, plain);
  const a = await context("First sentence here."),
    b = await context("Second sentence here."),
    c = await context("Third sentence here."),
    d = await context("Fourth sentence here.");
  s = addContext(s, a);
  s = togglePin(s, a.hash);
  s = addContext(s, b);
  s = addContext(s, c);
  expect(orderedContexts(s).map((c) => c.hash)).toEqual([
    a.hash,
    c.hash,
    b.hash,
  ]);
  expect(defaultReplacement(s)).toBe(b.hash);
  expect(() => addContext(s, d)).toThrow("替换一条");
  expect(() => addContext(s, d, a.hash)).toThrow("取消置顶");
  s = addContext(s, d, b.hash);
  s = await contextState(contextFields(s), plain);
  expect(orderedContexts(s).map((c) => c.hash)).toEqual([
    a.hash,
    d.hash,
    c.hash,
  ]);
  s = togglePin(s, a.hash);
  expect(orderedContexts(s).map((c) => c.hash)).toEqual([
    d.hash,
    c.hash,
    a.hash,
  ]);
  expect(() =>
    addContext(s, { ...d, text: "FOURTH   sentence here!!!" }),
  ).toThrow("这句已保存过");
});
it("retains Anki edits and drops a pin whose exact content hash disappeared", async () => {
  const a = await context("An original sentence."),
    b = await context("Another saved sentence.");
  let s = addContext(addContext(await contextState({}, plain), a), b);
  s = togglePin(s, a.hash);
  const fields = contextFields(s);
  fields.Context1 = "An externally edited sentence.";
  s = await contextState(fields, plain);
  expect(s.pin).toBeUndefined();
  expect(s.contexts.some((c) => c.html === fields.Context1)).toBe(true);
  s = addContext(s, await context("A newly saved sentence."));
  expect(Object.values(contextFields(s))).toContain(
    "An externally edited sentence.",
  );
});
it("defaults to domain only and supports an explicit full URL preference", () => {
  expect(
    contextSource(
      "https://example.com/private?q=secret",
      "A page",
      "2026-10-31",
    ),
  ).toBe("example.com · A page · 2026-10-31");
  expect(
    contextSource("https://example.com/path", "A page", "2026-10-31", true),
  ).toContain("https://example.com/path");
});
