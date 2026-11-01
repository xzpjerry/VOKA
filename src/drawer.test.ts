// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { extract as extractRaw, highlightRule } from "./reading";
import {
  createDrawer,
  pageWords,
  pageWordCounts,
  sortPageWords,
  matchesFilter,
} from "./drawer";
import { readFileSync } from "node:fs";
import { createData } from "./data";
import type { Token } from "./reading";
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

const drawerMessages: Record<string, string> = {
  reviewButton: "复习",
  reviewNothingDue: "本页没有今日到期的词，可以点词卡练习",
  dueSummary: "· {count} 张今日到期",
  drawerSummary: "本页 {count} 个目标词",
  drawerEmpty: "暂无词汇",
  drawerFilter_target: "目标词",
  drawerFilter_learning: "学习中",
  drawerFilter_due: "今日到期",
  drawerFilter_missing: "词典没有",
  drawerFilter_all: "全部",
};

function dueToken(dueToday: boolean, known = false): Token {
  document.body.innerHTML = "<p>achieve</p>";
  const token = extract(document.body)[0];
  token.state = {
    fields: known ? { ManualStatus: "known" } : {},
    cards: [
      {
        cardId: dueToday ? "due-card" : "not-due-card",
        type: "review",
        queue: "review",
        intervalDays: 3,
        dueToday,
      },
    ],
  };
  return token;
}

function setupDrawer(tokens: Token[], status = "ok") {
  const sendMessage = vi.fn();
  vi.stubGlobal("chrome", {
    i18n: { getMessage: (key: string) => drawerMessages[key] ?? key },
    runtime: {
      getURL: () => "chrome-extension://test/options.html",
      sendMessage,
    },
    storage: { local: { set: vi.fn() } },
  });
  const root = document.createElement("div").attachShadow({ mode: "open" });
  const summary = document.createElement("span");
  const retry = document.createElement("button");
  const onExpanded = vi.fn();
  const onStartReview = vi.fn();
  const drawer = createDrawer(
    root,
    summary,
    retry,
    vi.fn(),
    onExpanded,
    onStartReview,
  );
  const section = document.createElement("section");
  section.append(drawer.header, drawer.body);
  root.append(section);
  drawer.update(tokens, undefined, status);
  return { root, drawer, onExpanded, onStartReview, sendMessage };
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("keeps the Review button visible while the drawer is collapsed and expanded", () => {
  const { root } = setupDrawer([dueToken(true)]);
  const button = root.querySelector<HTMLButtonElement>('[data-slot="review-button"]')!;
  expect(button.hidden).toBe(false);
  expect(root.querySelector(".drawer-toggle")?.getAttribute("aria-expanded")).toBe(
    "false",
  );

  root.querySelector<HTMLButtonElement>(".drawer-toggle")!.click();
  expect(root.querySelector(".drawer-toggle")?.getAttribute("aria-expanded")).toBe(
    "true",
  );
  expect(button.hidden).toBe(false);
});

it("hides the Review button whenever VOKA is not running", () => {
  for (const status of ["checking", "unreachable"]) {
    const { root } = setupDrawer([dueToken(true)], status);
    expect(
      root.querySelector<HTMLButtonElement>('[data-slot="review-button"]')!.hidden,
    ).toBe(true);
  }
});

it("starts the existing review callback for due page words, including known words", () => {
  const token = dueToken(true, true);
  const { root, onStartReview } = setupDrawer([token]);
  expect(root.querySelector('[data-slot="due-summary"]')?.textContent).toContain(
    "1 张今日到期",
  );

  root.querySelector<HTMLButtonElement>('[data-slot="review-button"]')!.click();

  expect(onStartReview).toHaveBeenCalledOnce();
  expect(onStartReview).toHaveBeenCalledWith([token]);
});

it("expands without collapsing when the Review button is clicked", () => {
  const { root } = setupDrawer([dueToken(true)]);
  root.querySelector<HTMLButtonElement>('[data-slot="review-button"]')!.click();
  expect(root.querySelector(".drawer-toggle")?.getAttribute("aria-expanded")).toBe(
    "true",
  );
});

it("shows the no-due message without starting review or messaging the background", () => {
  const { root, onStartReview, sendMessage } = setupDrawer([dueToken(false)]);

  root.querySelector<HTMLButtonElement>('[data-slot="review-button"]')!.click();

  const message = root.querySelector<HTMLElement>('[role="status"]');
  expect(message?.textContent).toBe(
    "本页没有今日到期的词，可以点词卡练习",
  );
  expect(message?.hidden).toBe(false);
  expect(onStartReview).not.toHaveBeenCalled();
  expect(sendMessage).not.toHaveBeenCalled();
  expect(root.querySelector(".drawer-toggle")?.getAttribute("aria-expanded")).toBe(
    "true",
  );
});
