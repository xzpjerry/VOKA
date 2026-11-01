// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import type { Token, WordState } from "./reading";
import { fullCard } from "./full-card";

function setup(exists: boolean, state?: WordState) {
  document.body.innerHTML = "<p>Benefit is useful.</p>";
  const text = document.querySelector("p")!.firstChild!;
  const range = document.createRange();
  range.setStart(text, 0);
  range.setEnd(text, 7);
  const token: Token = {
    key: "en:benefit",
    entry: {
      lemma: "benefit",
      level: "B1",
      GlossNative: "好处",
      GlossTarget: "an advantage",
    },
    recognized: true,
    range,
    style: "target",
  };
  const host = document.createElement("div");
  const root = host.attachShadow({ mode: "open" });
  document.body.append(host);
  const sendMessage = vi.fn(async () => ({
    data: {
      exists,
      fields: { Word: "benefit", GlossNative: "好处", GlossTarget: "an advantage" },
      contexts: [],
    },
  }));
  vi.stubGlobal("chrome", {
    runtime: { sendMessage },
    i18n: {
      getMessage: (key: string) =>
        key === "practiceWord" ? "Practice this word" : key,
    },
  });
  const ui = fullCard(
    root,
    () => ({
      nativeLanguage: "en",
      glossLanguage: "native",
      targetLevel: "B1",
      showAdvanced: false,
      hoverScope: "highlighted",
    }),
    vi.fn(),
    () => state,
  );
  return { ui, token, root };
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

const card = (dueToday: boolean): WordState => ({
  fields: {},
  cards: [
    {
      cardId: "card-1",
      type: dueToday ? "review" : "new",
      queue: dueToday ? "review" : "new",
      intervalDays: 0,
      dueToday,
    },
  ],
});

it("shows practice only for a not-due word with an Anki card", async () => {
  const future = setup(true, card(false));
  await future.ui.open(future.token);
  expect(future.root.querySelector("#voka-practice-word")?.textContent).toBe(
    "Practice this word",
  );

  const due = setup(true, card(true));
  await due.ui.open(due.token);
  expect(due.root.querySelector("#voka-practice-word")).toBeNull();

  const absent = setup(false);
  await absent.ui.open(absent.token);
  expect(absent.root.querySelector("#voka-practice-word")).toBeNull();
});
