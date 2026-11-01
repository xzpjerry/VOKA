import { t } from "./shared";
import { isDueToday, type ReadingSettings, type Token } from "./reading";
export const filters = ["target", "learning", "due", "missing", "all"] as const;
export type Filter = (typeof filters)[number];
export type PageWordSort = "first" | "frequency";
const pageWordId = (token: Token) =>
  token.recognized
    ? token.key
    : token.range.toString().toLocaleLowerCase("en");
/** Keep the first occurrence in document order, including after incremental rescans. */
export function pageWords(tokens: Token[]) {
  const sorted = [...tokens].sort((a, b) =>
    a.range.compareBoundaryPoints(Range.START_TO_START, b.range),
  );
  const seen = new Set<string>();
  return sorted.filter((token) => {
    const id = pageWordId(token);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
/** Count every token using the same identity as the deduplicated page word list. */
export function pageWordCounts(tokens: Token[]) {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    const id = pageWordId(token);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}
/** `words` is already in first-appearance order; keep that order for frequency ties. */
export function sortPageWords(
  words: Token[],
  counts: Map<string, number>,
  order: PageWordSort,
) {
  return words
    .map((token, index) => ({ token, index }))
    .sort((a, b) =>
      order === "frequency"
        ? (counts.get(pageWordId(b.token)) ?? 0) -
            (counts.get(pageWordId(a.token)) ?? 0) ||
          a.index - b.index
        : a.index - b.index,
    )
    .map(({ token }) => token);
}
export function matchesFilter(token: Token, filter: Filter) {
  if (filter === "all") return true;
  if (filter === "target")
    return token.style === "target" || token.style === "unknown";
  if (filter === "learning") return token.style === "learning";
  if (filter === "due") return isDueToday(token.state);
  return token.entry.dictionaryStatus === "missing";
}
export function createDrawer(
  root: ShadowRoot,
  summary: HTMLElement,
  retry: HTMLButtonElement,
  activate: (token: Token) => void,
  onExpanded: () => void = () => {},
  onStartReview: (tokens: Token[]) => void = () => {},
  reviewView?: HTMLElement,
  onStartPractice: (token: Token, cardId: string) => void = () => {},
) {
  const style = document.createElement("style");
  style.textContent = `[hidden]{display:none!important}section{width:min(600px,calc(100vw - 64px));display:block!important;padding:0!important}button,select{font:inherit}button:focus-visible,select:focus-visible{outline:2px solid #285e9e;outline-offset:2px}.drawer-toggle{width:100%;border:0;background:transparent;text-align:left;padding:12px 8px 12px 16px;display:flex;gap:12px;align-items:center}.drawer-toggle strong{color:#285e9e}.drawer-toggle .chevron{margin-left:auto}.drawer-due-summary{border:0;background:transparent;color:#285e9e;text-align:left;padding:8px 4px;white-space:nowrap}.drawer-due-summary:disabled{color:#566575;cursor:default}.drawer-body{padding:0 16px 16px;max-height:46vh;overflow:auto}.drawer-body[hidden]{display:none}.drawer-settings{display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin:12px 0}.drawer-settings label{display:flex;gap:6px;align-items:center}.drawer-filters{display:flex;gap:6px;flex-wrap:wrap;margin:12px 0}.drawer-filters button{border:1px solid #ccd3dc;border-radius:20px;background:white}.drawer-filters button[aria-pressed=true]{background:#e9f2ff;border-color:#285e9e}.drawer-sort{display:flex;align-items:center;gap:8px;margin:8px 0}.drawer-start-review{margin:4px 0 8px}.drawer-list{list-style:none;padding:0;margin:0}.drawer-list button{border:0;border-bottom:1px solid #edf0f3;background:white;width:100%;text-align:left;display:flex;justify-content:space-between;gap:16px;padding:9px 4px}.drawer-list button:hover{background:#f4f7fb}.drawer-list small{color:#607080}.drawer-connection{display:flex;align-items:center;gap:12px}`;
  root.append(style);
  const header = document.createElement("button");
  header.className = "drawer-toggle";
  header.type = "button";
  header.setAttribute("aria-expanded", "false");
  const brand = document.createElement("strong");
  brand.textContent = "VOKA";
  const dueSlot = document.createElement("button");
  dueSlot.type = "button";
  dueSlot.className = "drawer-due-summary";
  dueSlot.dataset.slot = "due-summary";
  dueSlot.hidden = true;
  dueSlot.disabled = true;
  const arrow = document.createElement("span");
  arrow.className = "chevron";
  arrow.textContent = t("drawerExpand");
  const updateLink = document.createElement("a");
  updateLink.textContent = t("upgradeNotice");
  updateLink.href = chrome.runtime.getURL("options.html?upgrade=1");
  updateLink.target = "_blank";
  updateLink.hidden = true;
  updateLink.onclick = event => {
    event.preventDefault(); event.stopPropagation();
    void chrome.runtime.sendMessage({ type: "open-gloss-upgrade" });
  };
  header.append(brand, summary, arrow);
  const headerRow = document.createElement("div");
  headerRow.style.cssText = "display:flex;align-items:center";
  header.style.flex = "1";
  dueSlot.style.flex = "0 0 auto";
  updateLink.style.cssText = "font:inherit;max-width:45%;padding:8px 12px 8px 0";
  headerRow.append(header, dueSlot, updateLink);
  const body = document.createElement("div");
  body.className = "drawer-body";
  body.id = "drawer-body";
  body.hidden = true;
  header.setAttribute("aria-controls", body.id);
  function setExpanded(expanded: boolean) {
    body.hidden = !expanded;
    header.setAttribute("aria-expanded", String(expanded));
    arrow.textContent = t(expanded ? "drawerCollapse" : "drawerExpand");
    if (expanded) onExpanded();
  }
  header.onclick = () => setExpanded(body.hidden);
  const connection = document.createElement("span");
  const row = document.createElement("div");
  row.className = "drawer-connection";
  row.append(connection, retry);
  const language = document.createElement("p");
  const controls = document.createElement("div");
  controls.className = "drawer-settings";
  function select(key: string, options: string[][]) {
    const label = document.createElement("label");
    label.textContent = t(key);
    const input = document.createElement("select");
    input.name = key;
    for (const [value, text] of options) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = t(text);
      input.append(option);
    }
    input.onchange = () =>
      void chrome.storage.local.set({ [key]: input.value });
    label.append(input);
    controls.append(label);
    return input;
  }
  const gloss = select("glossLanguage", [
    ["native", "glossNative"],
    ["target", "glossTarget"],
  ]);
  const advancedLabel = document.createElement("label");
  const advanced = document.createElement("input");
  advanced.type = "checkbox";
  advanced.name = "showAdvanced";
  advanced.onchange = () =>
    void chrome.storage.local.set({ showAdvanced: advanced.checked });
  advancedLabel.append(advanced, t("drawerAdvanced"));
  controls.append(advancedLabel);
  const hover = select("hoverScope", [
    ["highlighted", "drawerHighlighted"],
    ["all", "drawerAllRecognized"],
  ]);
  const tabs = document.createElement("div");
  tabs.className = "drawer-filters";
  tabs.setAttribute("role", "group");
  tabs.setAttribute("aria-label", t("drawerFilters"));
  const list = document.createElement("ul");
  list.className = "drawer-list";
  const sortLabel = document.createElement("label");
  sortLabel.className = "drawer-sort";
  sortLabel.append(document.createTextNode(t("drawerSortLabel")));
  const sortSelect = document.createElement("select");
  sortSelect.name = "drawerSort";
  for (const [value, key] of [
    ["first", "drawerSortFirst"],
    ["frequency", "drawerSortFrequency"],
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = t(key);
    sortSelect.append(option);
  }
  sortLabel.append(sortSelect);
  const empty = document.createElement("p");
  empty.textContent = t("drawerEmpty");
  let words: Token[] = [],
    counts = new Map<string, number>(),
    active: Filter = "target",
    sortOrder: PageWordSort = "first",
    dueCount = 0,
    status = "ok",
    reviewing = false;
  sortSelect.onchange = () => {
    sortOrder = sortSelect.value as PageWordSort;
    render();
  };
  const startReview = document.createElement("button");
  startReview.type = "button";
  startReview.className = "drawer-start-review";
  startReview.textContent = t("reviewStart");
  const buttons = filters.map((filter) => {
    const button = document.createElement("button");
    button.dataset.filter = filter;
    button.onclick = () => {
      active = filter;
      render();
    };
    tabs.append(button);
    return button;
  });
  function render() {
    buttons.forEach((button, index) => {
      const filter = filters[index];
      button.textContent =
        t("drawerFilter_" + filter) +
        " " +
        words.filter((word) => matchesFilter(word, filter)).length;
      button.setAttribute("aria-pressed", String(active === filter));
    });
    list.replaceChildren();
    for (const token of sortPageWords(words, counts, sortOrder).filter((word) =>
      matchesFilter(word, active),
    )) {
      const item = document.createElement("li"),
        button = document.createElement("button"),
        detail = document.createElement("small");
      button.dataset.key = token.key;
      const wordLabel = document.createElement("span");
      wordLabel.append(
        document.createTextNode(
          token.recognized ? token.entry.lemma : token.range.toString(),
        ),
        document.createTextNode(
          ` ${t("drawerCount").replace(
            "{count}",
            String(counts.get(pageWordId(token)) ?? 0),
          )}`,
        ),
      );
      button.append(wordLabel);
      detail.textContent = [
        token.entry.level,
        token.entry.dictionaryStatus === "missing"
          ? t("drawerFilter_missing")
          : "",
      ]
        .filter(Boolean)
        .join(" · ");
      button.append(detail);
      button.onclick = () => activate(token);
      item.append(button);
      list.append(item);
    }
    startReview.hidden =
      reviewing || active !== "due" || dueCount === 0 || status !== "ok";
    empty.hidden = reviewing || list.childElementCount > 0;
  }
  function setReviewing(value: boolean) {
    reviewing = value;
    for (const element of [row, language, controls, tabs, sortLabel, startReview, list, empty])
      element.hidden = value;
    if (reviewView) reviewView.hidden = !value;
    if (!value) render();
  }
  function beginReview() {
    if (status !== "ok" || dueCount === 0) return;
    const queue = [...words];
    setExpanded(true);
    setReviewing(true);
    onStartReview(queue);
  }
  root.addEventListener("voka-start-practice", (event) => {
    const detail = (event as CustomEvent<{ token?: Token; cardId?: string }>)
      .detail;
    if (status !== "ok" || !detail?.token || !detail.cardId) return;
    setExpanded(true);
    setReviewing(true);
    onStartPractice(detail.token, detail.cardId);
  });
  dueSlot.onclick = () => {
    if (dueSlot.disabled) return;
    active = "due";
    render();
    beginReview();
  };
  startReview.onclick = beginReview;
  body.append(row, language, controls, tabs, sortLabel, startReview, list, empty);
  if (reviewView) {
    reviewView.hidden = true;
    body.append(reviewView);
  }
  return {
    header: headerRow,
    body,
    async checkUpgrade() {
      try {
        const response = await chrome.runtime.sendMessage({ type: "upgrade-summary" });
        updateLink.hidden = !response?.data?.count;
      } catch { updateLink.hidden = true; }
    },
    update(tokens: Token[], config?: ReadingSettings, status = "ok") {
      thisStatus(status);
      if (status !== "ok") updateLink.hidden = true;
      words = pageWords(tokens);
      counts = pageWordCounts(tokens);
      render();
      connection.textContent = t(status === "ok" ? "connected" : "notRunning");
      summary.textContent =
        status === "ok"
          ? t("drawerSummary").replace(
              "{count}",
              String(
                words.filter((word) => matchesFilter(word, "target")).length,
              ),
            )
          : t(status === "checking" ? "checking" : "notRunning");
      dueCount = words.filter((word) => isDueToday(word.state)).length;
      dueSlot.textContent =
        dueCount > 0
          ? t("dueSummary").replace("{count}", String(dueCount))
          : t("dueNone");
      dueSlot.hidden = status !== "ok";
      dueSlot.disabled = status !== "ok" || dueCount === 0;
      dueSlot.setAttribute("aria-label", dueSlot.textContent);
      startReview.hidden =
        reviewing || active !== "due" || dueCount === 0 || status !== "ok";
      for (const input of [gloss, advanced, hover, sortSelect])
        input.disabled = status !== "ok";
      if (config) {
        language.textContent =
          t("drawerLearning") +
          " English · " +
          t("drawerLevel") +
          " " +
          config.targetLevel;
        gloss.value = config.glossLanguage;
        gloss.parentElement!.hidden = config.nativeLanguage === "en";
        advanced.checked = config.showAdvanced;
        hover.value = config.hoverScope;
      }
    },
    showList() {
      setReviewing(false);
    },
  };

  function thisStatus(value: string) {
    status = value;
  }
}
