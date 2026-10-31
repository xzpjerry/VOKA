import { t } from "./shared";
import type { ReadingSettings, Token } from "./reading";
export const filters = ["target", "learning", "missing", "all"] as const;
export type Filter = (typeof filters)[number];
/** Keep the first occurrence in document order, including after incremental rescans. */
export function pageWords(tokens: Token[]) {
  const sorted = [...tokens].sort((a, b) =>
    a.range.compareBoundaryPoints(Range.START_TO_START, b.range),
  );
  const seen = new Set<string>();
  return sorted.filter((token) => {
    const id = token.recognized
      ? token.key
      : token.range.toString().toLocaleLowerCase("en");
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
export function matchesFilter(token: Token, filter: Filter) {
  return (
    filter === "all" ||
    (filter === "target"
      ? token.style === "target" || token.style === "unknown"
      : filter === "learning"
        ? token.style === "learning"
        : !token.entry.GlossNative && !token.entry.GlossTarget)
  );
}
export function createDrawer(
  root: ShadowRoot,
  summary: HTMLElement,
  retry: HTMLButtonElement,
  activate: (token: Token) => void,
) {
  const style = document.createElement("style");
  style.textContent = `[hidden]{display:none!important}section{width:min(600px,calc(100vw - 64px));display:block!important;padding:0!important}button,select{font:inherit}button:focus-visible,select:focus-visible{outline:2px solid #285e9e;outline-offset:2px}.drawer-toggle{width:100%;border:0;background:transparent;text-align:left;padding:12px 16px;display:flex;gap:12px;align-items:center}.drawer-toggle strong{color:#285e9e}.drawer-toggle .chevron{margin-left:auto}.drawer-body{padding:0 16px 16px;max-height:46vh;overflow:auto}.drawer-body[hidden]{display:none}.drawer-settings{display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin:12px 0}.drawer-settings label{display:flex;gap:6px;align-items:center}.drawer-filters{display:flex;gap:6px;flex-wrap:wrap;margin:12px 0}.drawer-filters button{border:1px solid #ccd3dc;border-radius:20px;background:white}.drawer-filters button[aria-pressed=true]{background:#e9f2ff;border-color:#285e9e}.drawer-list{list-style:none;padding:0;margin:0}.drawer-list button{border:0;border-bottom:1px solid #edf0f3;background:white;width:100%;text-align:left;display:flex;justify-content:space-between;gap:16px;padding:9px 4px}.drawer-list button:hover{background:#f4f7fb}.drawer-list small{color:#607080}.drawer-connection{display:flex;align-items:center;gap:12px}`;
  root.append(style);
  const header = document.createElement("button");
  header.className = "drawer-toggle";
  header.type = "button";
  header.setAttribute("aria-expanded", "false");
  const brand = document.createElement("strong");
  brand.textContent = "VOKA";
  const dueSlot = document.createElement("span");
  dueSlot.dataset.slot = "due-summary";
  dueSlot.hidden = true;
  const arrow = document.createElement("span");
  arrow.className = "chevron";
  arrow.textContent = t("drawerExpand");
  header.append(brand, summary, dueSlot, arrow);
  const body = document.createElement("div");
  body.className = "drawer-body";
  body.id = "drawer-body";
  body.hidden = true;
  header.setAttribute("aria-controls", body.id);
  header.onclick = () => {
    body.hidden = !body.hidden;
    header.setAttribute("aria-expanded", String(!body.hidden));
    arrow.textContent = t(body.hidden ? "drawerExpand" : "drawerCollapse");
  };
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
  const empty = document.createElement("p");
  empty.textContent = t("drawerEmpty");
  let words: Token[] = [],
    active: Filter = "target";
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
    for (const token of words.filter((word) => matchesFilter(word, active))) {
      const item = document.createElement("li"),
        button = document.createElement("button"),
        detail = document.createElement("small");
      button.dataset.key = token.key;
      button.append(
        document.createTextNode(
          token.recognized ? token.entry.lemma : token.range.toString(),
        ),
      );
      detail.textContent = [
        token.entry.level,
        !token.entry.GlossNative && !token.entry.GlossTarget
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
    empty.hidden = list.childElementCount > 0;
  }
  body.append(row, language, controls, tabs, list, empty);
  return {
    header,
    body,
    update(tokens: Token[], config?: ReadingSettings, status = "ok") {
      words = pageWords(tokens);
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
      for (const input of [gloss, advanced, hover])
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
  };
}
