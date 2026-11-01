import { pageWords } from "./drawer";
import { sentenceForRange } from "./page-context";
import {
  isDueToday,
  type ReadingSettings,
  type Token,
} from "./reading";
import { t } from "./shared";

type Rating = "again" | "hard" | "good" | "easy";
type QueueItem = { token: Token; cardId: string };
type Prepared = {
  latestReviewId: unknown;
  predict: {
    stateToken: string;
    answers: Array<{
      rating: Rating;
      label: string;
      interval: unknown | null;
    }>;
  };
};
type Rendered = { questionHtml: string; answerHtml: string };

const ratingNames: Record<Rating, string> = {
  again: "reviewAgain",
  hard: "reviewHard",
  good: "reviewGood",
  easy: "reviewEasy",
};

function appendSanitizedHtml(target: HTMLElement, html: string) {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  parsed
    .querySelectorAll(
      "script,style,iframe,object,embed,link,audio,video,base",
    )
    .forEach((element) => element.remove());
  for (const element of Array.from(parsed.querySelectorAll("*"))) {
    for (const attribute of Array.from(element.attributes)) {
      if (
        /^on/i.test(attribute.name) ||
        /javascript\s*:/i.test(attribute.value)
      )
        element.removeAttribute(attribute.name);
    }
  }
  target.replaceChildren(
    ...Array.from(parsed.body.childNodes, (node) =>
      document.importNode(node, true),
    ),
  );
}

export function createReviewUI(
  root: ShadowRoot,
  config: () => ReadingSettings,
  onReturnToList: () => void,
  onRefresh: () => void,
) {
  const style = document.createElement("style");
  style.textContent =
    ".review-view{border-top:1px solid #e4e8ed;margin-top:12px;padding-top:12px}.review-view[hidden]{display:none}.review-view h3{font-size:18px;margin:0 0 10px}.review-view .practice-label{position:sticky;top:0;z-index:1;background:#fff;padding:4px 0 8px;color:#566575;font-size:12px;font-weight:600}.review-view .review-question,.review-view .review-answer{padding:10px 12px;border:1px solid #e4e8ed;border-radius:8px;overflow-wrap:anywhere}.review-view .review-sentence{margin:10px 0;padding:9px 12px;background:#f5f7fa;border-radius:8px;white-space:pre-wrap}.review-view .review-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}.review-view .review-status{min-height:1.4em;margin:10px 0;color:#566575}.review-view button{border:1px solid #ccd3dc;border-radius:6px;background:#fff;color:#17212b;padding:6px 10px}.review-view button:disabled{opacity:.55;cursor:wait}.review-view button[data-primary=true]{background:#285e9e;color:#fff;border-color:#285e9e}#voka-review-ui[hidden]{display:none}";
  const view = document.createElement("section");
  view.id = "voka-review-ui";
  view.className = "review-view";
  view.dataset.slot = "review-ui";
  view.hidden = true;
  root.append(style);

  let queue: QueueItem[] = [];
  let index = 0;
  let mode: "review" | "practice" = "review";
  let epoch = 0;
  let rendered: Rendered | undefined;
  let prepared: Prepared | undefined;
  let sentence: ReturnType<typeof sentenceForRange> | undefined;
  let sentenceOnBack = false;
  let revealed = false;
  let preparing = false;
  let submitting = false;
  let unresolved = false;
  let advancePending = false;
  let loadFailed = false;
  let status = "";
  let frontShownAt = 0;
  let practiceNoCard = false;

  function activeItem() {
    return queue[index];
  }

  function button(label: string, action: () => void, primary = false) {
    const result = document.createElement("button");
    result.type = "button";
    result.textContent = label;
    result.dataset.primary = String(primary);
    result.onclick = action;
    return result;
  }

  function appendSentence(parent: HTMLElement) {
    if (!sentence) return;
    const paragraph = document.createElement("p");
    paragraph.className = "review-sentence";
    paragraph.innerHTML = sentence.html;
    parent.append(paragraph);
  }

  function render() {
    view.replaceChildren();
    if (mode === "practice") {
      const label = document.createElement("div");
      label.className = "practice-label";
      label.textContent = t("practiceLabel");
      label.setAttribute("role", "note");
      view.append(label);
    }

    if (mode === "practice" && practiceNoCard) {
      const message = document.createElement("p");
      message.className = "review-status";
      message.setAttribute("role", "status");
      message.textContent = t("practiceNoCard");
      const actions = document.createElement("div");
      actions.className = "review-actions";
      actions.append(
        button(t("practiceReturn"), () => returnToList(), true),
      );
      view.append(message, actions);
      return;
    }

    const item = activeItem();
    if (!item) {
      const heading = document.createElement("h3");
      heading.textContent = t("reviewFinished");
      const actions = document.createElement("div");
      actions.className = "review-actions";
      actions.append(
        button(t("reviewReturn"), onReturnToList, true),
      );
      view.append(heading, actions);
      return;
    }

    const heading = document.createElement("h3");
    heading.textContent = mode === "practice"
      ? item.token.entry.lemma
      : `${item.token.entry.lemma} · ${index + 1}/${queue.length}`;
    view.append(heading);

    if (!rendered) {
      const loading = document.createElement("p");
      loading.className = "review-status";
      loading.setAttribute("role", "status");
      loading.textContent = status || t("reviewLoading");
      view.append(loading);
      if (loadFailed) {
        const actions = document.createElement("div");
        actions.className = "review-actions";
        actions.append(
          button(
            mode === "practice" ? t("practiceReturn") : t("reviewNext"),
            () => (mode === "practice" ? returnToList() : nextCard()),
          ),
        );
        view.append(actions);
      }
      return;
    }

    const question = document.createElement("div");
    question.id = "voka-review-question";
    question.className = "review-question";
    appendSanitizedHtml(question, rendered.questionHtml);
    view.append(question);
    if (!revealed && !sentenceOnBack) appendSentence(view);

    const actions = document.createElement("div");
    actions.className = "review-actions";
    if (!revealed) {
      const reveal = button(
        t("reviewShowAnswer"),
        () => void showAnswer(),
        true,
      );
      if (mode === "practice")
        reveal.dataset.practiceAction = "show-answer";
      actions.append(reveal);
    } else {
      const answer = document.createElement("div");
      answer.id = "voka-review-answer";
      answer.className = "review-answer";
      appendSanitizedHtml(answer, rendered.answerHtml);
      view.append(answer);
      if (sentenceOnBack) appendSentence(view);

      if (mode === "practice") {
        const next = button(t("reviewNext"), () => returnToList(), true);
        next.dataset.practiceAction = "next";
        actions.append(next);
      } else if (preparing) {
        status = status || t("reviewPreparing");
      } else if (prepared && !unresolved && !advancePending) {
        for (const option of prepared.predict.answers) {
          const name = ratingNames[option.rating];
          const label =
            option.interval == null
              ? t(name)
              : `${t(name)} · ${option.label}`;
          const ratingButton = button(label, () => void rate(option.rating));
          ratingButton.dataset.reviewRating = option.rating;
          ratingButton.disabled = submitting;
          actions.append(ratingButton);
        }
      } else if (!unresolved && !advancePending) {
        actions.append(button(t("reviewRetry"), () => void prepare(epoch)));
      }
      if (unresolved)
        actions.append(button(t("reviewNext"), () => nextCard()));
    }
    if (actions.childElementCount) view.append(actions);

    const message = document.createElement("p");
    message.className = "review-status";
    message.setAttribute("role", "status");
    message.id = "voka-review-status";
    message.textContent = status;
    view.append(message);
  }

  async function request<T>(type: string, params: Record<string, unknown>) {
    const response = await chrome.runtime.sendMessage({ type, ...params });
    if (response?.error) throw new Error(response.error);
    return response?.data as T;
  }

  async function loadCurrent() {
    const item = activeItem();
    const currentEpoch = ++epoch;
    rendered = undefined;
    prepared = undefined;
    sentence = undefined;
    sentenceOnBack = false;
    revealed = false;
    preparing = false;
    submitting = false;
    unresolved = false;
    advancePending = false;
    loadFailed = false;
    status = "";
    render();
    if (!item) return;

    try {
      const result = await request<Rendered>("review-render", {
        cardId: item.cardId,
      });
      if (currentEpoch !== epoch) return;
      rendered = result;
      try {
        sentence = sentenceForRange(item.token.range);
        sentenceOnBack =
          config().nativeLanguage === "zh" && /[㐀-鿿]/.test(sentence.text);
      } catch {
        sentence = undefined;
      }
      frontShownAt = performance.now();
      render();
    } catch {
      if (currentEpoch !== epoch) return;
      status = t("reviewLoadError");
      loadFailed = true;
      render();
    }
  }

  async function prepare(currentEpoch: number, preserveStatus = false) {
    const item = activeItem();
    if (!item) return;
    preparing = true;
    prepared = undefined;
    render();
    try {
      const result = await request<Prepared>("review-prepare", {
        cardId: item.cardId,
      });
      if (currentEpoch !== epoch) return;
      prepared = result;
      if (!preserveStatus) status = "";
    } catch {
      if (currentEpoch !== epoch) return;
      status = t("reviewPrepareError");
    } finally {
      if (currentEpoch === epoch) {
        preparing = false;
        render();
      }
    }
  }

  async function showAnswer() {
    if (revealed || preparing || submitting) return;
    revealed = true;
    if (mode === "practice") {
      status = "";
      render();
      return;
    }
    preparing = true;
    status = t("reviewPreparing");
    render();
    await prepare(epoch);
  }

  async function rate(rating: Rating) {
    const item = activeItem();
    if (!item || !prepared || submitting || unresolved) return;
    submitting = true;
    status = t("reviewSubmitting");
    render();
    const currentEpoch = epoch;
    try {
      const result = await request<{
        outcome: "submitted" | "confirmed" | "notDue" | "conflict" | "unknown";
      }>("review-submit", {
        cardId: item.cardId,
        rating,
        stateToken: prepared.predict.stateToken,
        latestReviewId: prepared.latestReviewId,
        elapsedMs: Math.round(Math.max(0, performance.now() - frontShownAt)),
      });
      if (currentEpoch !== epoch) return;
      submitting = false;
      if (result.outcome === "submitted" || result.outcome === "confirmed") {
        onRefresh();
        nextCard();
      } else if (result.outcome === "notDue") {
        status = t("reviewNotDue");
        advancePending = true;
        onRefresh();
        render();
        setTimeout(() => {
          if (currentEpoch === epoch) nextCard();
        }, 1500);
      } else if (result.outcome === "conflict") {
        status = t("reviewConflict");
        await prepare(currentEpoch, true);
      } else {
        unresolved = true;
        status = t("reviewUnknown");
        render();
      }
    } catch {
      if (currentEpoch !== epoch) return;
      submitting = false;
      unresolved = true;
      status = t("reviewUnknown");
      render();
    }
  }

  function nextCard() {
    if (submitting) return;
    if (mode === "practice") {
      returnToList();
      return;
    }
    index++;
    void loadCurrent();
  }

  function returnToList() {
    mode = "review";
    practiceNoCard = false;
    queue = [];
    index = 0;
    rendered = undefined;
    prepared = undefined;
    sentence = undefined;
    status = "";
    view.hidden = true;
    onReturnToList();
  }

  chrome.runtime.onMessage.addListener((message) => {
    const item = activeItem();
    if (
      message?.type === "review-confirming" &&
      item?.cardId === message.cardId &&
      submitting
    ) {
      status = t("reviewConfirming");
      render();
    }
  });

  return {
    element: view,
    start(tokens: Token[]) {
      mode = "review";
      practiceNoCard = false;
      queue = pageWords(tokens).flatMap((token) => {
        if (!isDueToday(token.state)) return [];
        const card = token.state?.cards.find(
          (candidate) =>
            candidate.dueToday &&
            !["suspended", "buriedByScheduler", "buriedByUser"].includes(
              candidate.queue,
            ),
        );
        return card ? [{ token, cardId: card.cardId }] : [];
      });
      index = 0;
      view.hidden = false;
      void loadCurrent();
    },
    practice(token: Token, cardId?: string) {
      mode = "practice";
      queue = cardId ? [{ token, cardId }] : [];
      index = 0;
      practiceNoCard = !cardId;
      view.hidden = false;
      if (!cardId) {
        ++epoch;
        rendered = undefined;
        prepared = undefined;
        sentence = undefined;
        sentenceOnBack = false;
        revealed = false;
        preparing = false;
        submitting = false;
        unresolved = false;
        advancePending = false;
        loadFailed = false;
        status = t("practiceNoCard");
        render();
        return;
      }
      void loadCurrent();
    },
  };
}
