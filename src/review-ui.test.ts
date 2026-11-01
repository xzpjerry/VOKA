// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import type { ReadingSettings, Token } from "./reading";
import { createReviewUI } from "./review-ui";

const config: ReadingSettings = {
  nativeLanguage: "en",
  glossLanguage: "native",
  targetLevel: "B1",
  showAdvanced: false,
  hoverScope: "highlighted",
};

function setup(sendMessage = vi.fn(async (_message: { type: string }) => ({
  data: {
    questionHtml: "<div>benefit</div>",
    answerHtml: "<div>an advantage</div>",
  },
}))) {
  document.body.innerHTML = "<p>A benefit is useful.</p>";
  const text = document.querySelector("p")!.firstChild!;
  const range = document.createRange();
  range.setStart(text, 2);
  range.setEnd(text, 9);
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
    state: {
      fields: {},
      cards: [
        {
          cardId: "card-1",
          type: "new",
          queue: "new",
          intervalDays: 0,
          dueToday: false,
        },
      ],
    },
  };
  const host = document.createElement("div");
  const root = host.attachShadow({ mode: "open" });
  const onReturnToList = vi.fn();
  const onRefresh = vi.fn();
  const addListener = vi.fn();
  vi.stubGlobal("chrome", {
    runtime: { sendMessage, onMessage: { addListener } },
    i18n: {
      getMessage: (key: string) =>
        ({
          practiceLabel: "Practice · not recorded in Anki",
          practiceNoCard: "This word is not in Anki yet",
          practiceReturn: "Back",
          reviewShowAnswer: "Show answer",
          reviewNext: "Next",
          reviewLoading: "Loading card…",
          reviewLoadError: "Could not load the review card",
        })[key] ?? key,
    },
  });
  const ui = createReviewUI(root, () => config, onReturnToList, onRefresh);
  return { ui, token, sendMessage, onReturnToList };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("shows the practice label and no rating buttons after revealing the answer", async () => {
  const { ui, token } = setup();
  ui.practice(token, "card-1");
  await flush();

  expect(ui.element.querySelector(".practice-label")?.textContent).toBe(
    "Practice · not recorded in Anki",
  );
  expect(ui.element.querySelector("#voka-review-question")?.textContent).toContain(
    "benefit",
  );
  ui.element
    .querySelector<HTMLButtonElement>('[data-practice-action="show-answer"]')!
    .click();
  expect(ui.element.querySelector("#voka-review-answer")?.textContent).toContain(
    "an advantage",
  );
  expect(ui.element.querySelectorAll("[data-review-rating]")).toHaveLength(0);
  expect(ui.element.querySelector('[data-practice-action="next"]')).not.toBeNull();
});

it("sends only review-render during a complete practice run", async () => {
  const { ui, token, sendMessage, onReturnToList } = setup();
  ui.practice(token, "card-1");
  await flush();
  ui.element
    .querySelector<HTMLButtonElement>('[data-practice-action="show-answer"]')!
    .click();
  ui.element
    .querySelector<HTMLButtonElement>('[data-practice-action="next"]')!
    .click();

  expect(sendMessage.mock.calls.map(([message]) => (message as any).type)).toEqual([
    "review-render",
  ]);
  expect(onReturnToList).toHaveBeenCalledOnce();
  expect(ui.element.hidden).toBe(true);
});

it("shows a return path when the word has no Anki card", () => {
  const { ui, token, sendMessage, onReturnToList } = setup();
  ui.practice(token);

  expect(ui.element.textContent).toContain("This word is not in Anki yet");
  expect(ui.element.querySelector(".practice-label")).not.toBeNull();
  expect(sendMessage).not.toHaveBeenCalled();
  ui.element.querySelector<HTMLButtonElement>("button")!.click();
  expect(onReturnToList).toHaveBeenCalledOnce();
});
