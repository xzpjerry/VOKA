// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { DynamicReading } from "./dynamic-reading";
import { readFileSync } from "node:fs";
import { createData } from "./data";
import { Window } from "happy-dom";
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
it("discovers and extracts text from the root's own iframe document", async () => {
  const parentWindow = new Window({
    settings: { enableIframePageLoading: true },
  });
  const parentDoc = parentWindow.document as unknown as Document;
  const iframe = parentDoc.createElement("iframe");
  parentDoc.body.append(iframe);
  const doc = iframe.contentDocument! as unknown as Document;
  doc.open();
  doc.write("<!doctype html><html><body><p>achieve</p></body></html>");
  doc.close();
  const highlights = {
    target: new Set<Range>(),
    learning: new Set<Range>(),
    unknown: new Set<Range>(),
    weak: new Set<Range>(),
  };
  const session = new DynamicReading(
    config,
    highlights,
    async () => ({}),
    () => {},
    undefined,
    resolveWords,
  );

  try {
    await session.start(doc.body);
    expect(session.tokens.map((token) => token.range.toString())).toEqual([
      "achieve",
    ]);
    expect(session.tokens[0].range.startContainer.ownerDocument).toBe(doc);
  } finally {
    session.stop();
    iframe.remove();
    parentWindow.close();
  }
});
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
it("reapplies manual precedence to existing ranges without rescanning", async () => {
  document.body.innerHTML = "<p>benefit banana</p>";
  const highlights = {
    target: new Set<Range>(),
    learning: new Set<Range>(),
    unknown: new Set<Range>(),
    weak: new Set<Range>(),
  };
  const lookup = vi.fn(async (_keys: string[]) => ({}));
  const session = new DynamicReading(
    { ...config, targetLevel: "B1" },
    highlights,
    lookup,
    () => {
      throw Error("failed");
    },
    undefined,
    resolveWords,
  );
  await session.start(document.body);
  const texts = (ranges: Set<Range>) =>
    [...ranges].map((range) => range.toString());
  expect(texts(highlights.target)).toEqual(["benefit"]);
  session.states["en:benefit"] = {
    fields: { ManualStatus: "known" },
    cards: [],
  };
  session.states["en:banana"] = {
    fields: { ManualStatus: "unknown" },
    cards: [],
  };
  session.refresh("en:benefit");
  session.refresh("en:banana");
  expect(texts(highlights.target)).toEqual([]);
  expect(texts(highlights.unknown)).toEqual(["banana"]);
  session.states["en:benefit"].fields.ManualStatus = "";
  session.states["en:banana"].fields.ManualStatus = "";
  session.refresh("en:benefit");
  session.refresh("en:banana");
  expect(texts(highlights.target)).toEqual(["benefit"]);
  expect(texts(highlights.unknown)).toEqual([]);
  expect(lookup).toHaveBeenCalledTimes(1);
  session.stop();
});
it("keeps mature due underlines separate and refreshes known status", async () => {
  document.body.innerHTML = "<p>benefit benefit</p>";
  const highlights = {
    target: new Set<Range>(),
    learning: new Set<Range>(),
    unknown: new Set<Range>(),
    weak: new Set<Range>(),
  };
  const due = new Set<Range>();
  const session = new DynamicReading(
    config,
    highlights,
    async () => ({
      "en:benefit": {
        fields: {},
        cards: [
          {
            cardId: "mature",
            type: "review",
            queue: "review",
            intervalDays: 30,
            dueToday: true,
          },
        ],
      },
    }),
    () => {},
    undefined,
    resolveWords,
    due,
  );
  await session.start(document.body);
  expect([...due].map((range) => range.toString())).toEqual([
    "benefit",
    "benefit",
  ]);
  expect(highlights.target.size + highlights.learning.size).toBe(0);
  session.states["en:benefit"].fields.ManualStatus = "known";
  session.refresh("en:benefit");
  expect(due.size).toBe(0);
  session.states["en:benefit"].fields.ManualStatus = "";
  session.refresh("en:benefit");
  expect(due.size).toBe(2);
  session.stop();
});
it("keeps a surface choice for existing and newly scanned occurrences", async () => {
  document.body.innerHTML = "<p>saw saw</p>";
  const highlights = { target: new Set<Range>(), learning: new Set<Range>(), unknown: new Set<Range>(), weak: new Set<Range>() };
  const session = new DynamicReading(config, highlights, async () => ({}), () => {}, undefined, resolveWords);
  await session.start(document.body);
  session.states["en:see"] = { fields: { ManualStatus: "unknown" }, cards: [] };
  session.choose("saw", { key: "en:see", entry: data.lookupEntry("see") });
  expect(session.tokens.map(t => t.key)).toEqual(["en:see", "en:see"]);
  expect(highlights.unknown.size).toBe(2);
  const observer = new MutationObserver(records => session.update(records));
  observer.observe(document.body, { subtree: true, childList: true });
  document.body.insertAdjacentHTML("beforeend", "<p>saw</p>");
  await vi.waitFor(() => expect(session.tokens).toHaveLength(3));
  expect(session.tokens.every(t => t.key === "en:see")).toBe(true);
  expect(highlights.unknown.size).toBe(3);
  observer.disconnect(); session.stop();
});
