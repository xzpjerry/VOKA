// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { DynamicReading } from "./dynamic-reading";
import { readFileSync } from "node:fs";
import { createData } from "./data";
const data = createData(
  ["cefrj", "octanove", "oewn", "readings", "oewn-readings", "morphology"].map(
    (name) => JSON.parse(readFileSync(`public/data/${name}.json`, "utf8")),
  ),
);
const resolveWords = async (words: string[]) =>
  Object.fromEntries(
    words.map((word) => {
      const entry = data.lookupEntry(data.lemmaCandidates(word)[0] ?? word);
      return [word, { key: `en:${entry.lemma}`, entry }];
    }),
  );
const config = {
  nativeLanguage: "zh",
  glossLanguage: "native",
  targetLevel: "A2",
  showAdvanced: false,
  hoverScope: "highlighted",
} as const;
it("retains unaffected ranges, caches absent Keys, and drops replaced/detached ranges", async () => {
  document.body.innerHTML = "<main><p>achieve</p><p>improve</p></main>";
  const highlights = {
    target: new Set<Range>(),
    learning: new Set<Range>(),
    unknown: new Set<Range>(),
    weak: new Set<Range>(),
  };
  const lookup = vi.fn(async (_keys: string[]) => ({}));
  const resolver = vi.fn(resolveWords);
  const session = new DynamicReading(
    config,
    highlights,
    lookup,
    () => {
      throw Error("failed");
    },
    undefined,
    resolver,
  );
  await session.start(document.body);
  const initialCalls = lookup.mock.calls.length;
  const retained = [...highlights.target][0];
  const observer = new MutationObserver((records) => session.update(records));
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
  });
  document.querySelectorAll("p")[1].textContent = "achieve develop";
  await vi.waitFor(() => expect(highlights.target.size).toBe(3));
  expect(highlights.target.has(retained)).toBe(true);
  expect(lookup.mock.calls[initialCalls][0]).toEqual(["en:develop"]);
  document.querySelectorAll("p")[1].remove();
  await vi.waitFor(() => expect(highlights.target.size).toBe(1));
  document
    .querySelector("main")!
    .insertAdjacentHTML("beforeend", "<p>develop achieve</p>");
  await vi.waitFor(() => expect(highlights.target.size).toBe(3));
  expect(lookup).toHaveBeenCalledTimes(initialCalls + 1);
  expect(resolver.mock.calls.flatMap(([words]) => words).sort()).toEqual([
    "achieve",
    "develop",
    "improve",
  ]);
  document.querySelectorAll("p")[1].textContent = "";
  await vi.waitFor(() => expect(highlights.target.size).toBe(1));
  document.querySelector("main")!.hidden = true;
  await vi.waitFor(() => expect(highlights.target.size).toBe(0));
  observer.disconnect();
  session.stop();
});
it("does not publish stale responses when a block changes during lookup", async () => {
  document.body.innerHTML = "<p>achieve</p>";
  let resolve!: (value: {}) => void;
  const lookup = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    )
    .mockResolvedValue({});
  const highlights = {
    target: new Set<Range>(),
    learning: new Set<Range>(),
    unknown: new Set<Range>(),
    weak: new Set<Range>(),
  };
  const session = new DynamicReading(
    config,
    highlights,
    lookup,
    () => {},
    undefined,
    resolveWords,
  );
  const start = session.start(document.body);
  const observer = new MutationObserver((records) => session.update(records));
  observer.observe(document.body, { subtree: true, childList: true });
  document.querySelector("p")!.textContent = "develop";
  await new Promise((r) => setTimeout(r, 0));
  resolve({});
  await start;
  expect([...highlights.target].map((r) => r.toString())).toEqual(["develop"]);
  observer.disconnect();
  session.stop();
});
