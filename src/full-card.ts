import {
  defaultReplacement,
  normalizeSentence,
  type Context,
} from "./contexts";
import { sentenceForRange } from "./page-context";
import {
  gloss,
  highlightRule,
  type Token,
  type ReadingSettings,
  type WordState,
} from "./reading";
import { manualAction } from "./manual";
type View = {
  exists: boolean;
  fields: Record<string, string>;
  contexts: Context[];
  pin?: string;
};
export function fullCard(
  root: ShadowRoot,
  config: () => ReadingSettings,
  updated: (key: string, fields: Record<string, string>) => void,
  stateFor: (key: string) => WordState | undefined = () => undefined,
  choose: (token: Token, entry: Token["entry"]) => Promise<void> = async () => {},
) {
  const card = document.createElement("aside");
  card.id = "voka-card";
  card.hidden = true;
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "VOKA 词条");
  const style = document.createElement("style");
  style.textContent =
    "#voka-card{position:fixed;right:20px;bottom:70px;width:min(360px,calc(100vw - 40px));max-height:75vh;overflow:auto;box-sizing:border-box;background:#fff;color:#17212b;border:1px solid #d8dce2;border-radius:12px;box-shadow:0 8px 28px #0003;padding:16px;font:14px/1.5 system-ui}#voka-card[hidden]{display:none}#voka-card h2{font:600 24px Georgia;margin:0 0 6px}#voka-card p{margin:8px 0}#voka-card button{border:1px solid #ccd3dc;border-radius:6px;background:#fff;color:#17212b;margin:4px 4px 4px 0}#voka-card .primary{background:#2f6fde;color:white}#voka-card small{color:#657180}#voka-card label{display:flex;align-items:start;gap:6px;border-top:1px solid #eee;padding:8px 0}#voka-card .sentence{white-space:pre-wrap}";
  root.append(style, card);
  let active: Token | undefined,
    view: View,
    epoch = 0,
    busy = false,
    list = false,
    selected: string | undefined,
    message = "";
  const text = (html: string) => {
    const t = document.createElement("template");
    t.innerHTML = html;
    return t.content.textContent || "";
  };
  async function request(action: string, extra: Record<string, unknown> = {}) {
    const response = await chrome.runtime.sendMessage({
      type: "card-context",
      key: active!.key,
      action,
      ...extra,
    });
    if (response.error) throw new Error(response.error);
    return response.data as View;
  }
  function close() {
    ++epoch;
    active = undefined;
    card.hidden = true;
  }
  function element<K extends keyof HTMLElementTagNameMap>(tag: K, value = "") {
    const el = document.createElement(tag);
    el.textContent = value;
    return el;
  }
  function button(label: string, fn: () => void, primary = false) {
    const b = element("button", label);
    b.type = "button";
    b.disabled = busy;
    if (primary) b.className = "primary";
    b.onclick = fn;
    return b;
  }
  function render() {
    if (!active) return;
    card.replaceChildren();
    const closeButton = button("×", close);
    closeButton.setAttribute("aria-label", "关闭");
    closeButton.style.float = "right";
    card.append(closeButton);
    const fields = view.fields,
      token = active;
    card.append(element("h2", text(fields.Word || token.entry.lemma)));
    const state = stateFor(token.key);
    const types = state?.cards.map((c) => c.type) || [];
    const ankiStatus = !view.exists
      ? "未加入 Anki"
      : types.some((t) => t === "learning" || t === "relearning")
        ? "Anki 学习中"
        : types.includes("review")
          ? "Anki 复习中"
          : "Anki 新卡";
    card.append(
      element(
        "small",
        [
          text(
            fields.Reading ||
              ("Reading" in token.entry ? String(token.entry.Reading) : ""),
          ),
          token.entry.level || state?.level || "未分级",
          ankiStatus,
        ]
          .filter(Boolean)
          .join(" · "),
      ),
    );
    const candidates = element("div");
    candidates.dataset.slot = "lemma-candidates";
    const others = token.candidates?.filter((entry) => entry.lemma !== token.entry.lemma) ?? [];
    if (others.length) {
      candidates.append(element("span", `「${token.range.toString()}」也可能是：`));
      for (const entry of others) {
        const option = button(entry.lemma, () => void (async () => {
          if (busy) return;
          busy = true;
          render();
          const current = epoch;
          try {
            await choose(token, entry);
            if (current === epoch) await open(token);
          } catch (error) {
            if (current !== epoch) return;
            message = (error as Error).message;
            busy = false;
            render();
          }
        })());
        option.dataset.key = `en:${entry.lemma}`;
        candidates.append(option);
      }
    }
    card.append(candidates);
    const primary = gloss(
      token,
      config(),
      view.exists ? { fields, cards: [] } : undefined,
    );
    card.append(element("p", text(primary) || "词典没有"));
    if (primary && token.entry.dictionaryStatus === "missing")
      card.append(element("small", "词典没有"));
    const alternate =
      config().glossLanguage === "native" && config().nativeLanguage !== "en"
        ? (fields.GlossTarget ?? token.entry.GlossTarget)
        : (fields.GlossNative ?? token.entry.GlossNative);
    if (alternate && alternate !== primary) {
      const details = element("details");
      details.append(
        element("summary", "展开另一种释义"),
        element("p", text(alternate)),
      );
      card.append(details);
    }
    const manual = element("div");
    manual.dataset.slot = "manual-status";
    const action = manualAction(
      fields.ManualStatus,
      highlightRule(
        token.entry.level || state?.level,
        config(),
        state,
      ) !== null,
    );
    const manualButton = button(
      action.label,
      () => void mutate("manual", { manual: action.status }),
    );
    manualButton.id = "voka-manual-status";
    manualButton.dataset.manual = action.status || "clear";
    manual.append(manualButton);
    card.append(manual);
    let sentence: ReturnType<typeof sentenceForRange> | undefined,
      error = "";
    try {
      sentence = sentenceForRange(token.range);
    } catch (e) {
      error = (e as Error).message;
    }
    if (sentence) card.append(element("p", sentence.text));
    const duplicate =
      !!sentence &&
      view.contexts.some(
        (c) => normalizeSentence(c.text) === normalizeSentence(sentence!.text),
      );
    const label = duplicate
      ? "这句已保存过"
      : !view.exists
        ? "加入 Anki（含这句例句）"
        : view.contexts.length === 3
          ? "替换一条…"
          : `保存这句为例句（${view.contexts.length}/3）`;
    const save = button(
      label,
      () => {
        if (view.contexts.length === 3) {
          list = !list;
          selected = defaultReplacement({ ...view, meta: {} });
          render();
        } else void mutate("save", sentence!);
      },
      true,
    );
    save.id = "voka-save-context";
    save.disabled = busy || duplicate || !sentence;
    card.append(save);
    if (view.contexts.length && !list)
      card.append(
        button("查看例句 / ★ 置顶", () => {
          list = true;
          render();
        }),
      );
    if (list) {
      const group = element("div");
      group.id = "voka-context-list";
      for (const c of view.contexts) {
        const row = element("label");
        const radio = element("input");
        radio.type = "radio";
        radio.name = "replace";
        radio.value = c.hash;
        radio.checked = selected === c.hash;
        radio.disabled = busy || c.hash === view.pin;
        radio.onchange = () => {
          selected = c.hash;
        };
        const content = element("span", c.text);
        content.className = "sentence";
        content.append(element("small", " " + text(c.source)));
        const pin = button(
          view.pin === c.hash ? "★" : "☆",
          () => void mutate("pin", { hash: c.hash }),
        );
        pin.setAttribute(
          "aria-label",
          view.pin === c.hash ? "取消置顶" : "置顶",
        );
        row.append(radio, content, pin);
        group.append(row);
      }
      if (view.contexts.length === 3 && !duplicate && sentence)
        group.append(
          button(
            "确认替换",
            () => void mutate("save", { ...sentence!, replace: selected }),
            true,
          ),
        );
      card.append(group);
    }
    const status = element("p", message || error);
    status.setAttribute("role", "status");
    card.append(status);
  }
  async function mutate(action: string, extra: Record<string, unknown>) {
    if (busy) return;
    busy = true;
    message = "";
    render();
    const current = epoch;
    try {
      const next = await request(action, { ...extra, title: document.title });
      if (current !== epoch) return;
      view = next;
      message =
        action === "manual"
          ? view.fields.ManualStatus === "known"
            ? "已标为认识"
            : view.fields.ManualStatus === "unknown"
              ? "已标为不认识"
              : "已撤销标记"
          : action === "pin"
            ? "置顶已更新"
            : "例句已保存";
      list = false;
      updated(active!.key, view.fields);
    } catch (e) {
      if (current !== epoch) return;
      message = (e as Error).message;
      // A stale replacement selection may refer to an Anki-edited sentence.
      try {
        const refreshed = await request("read");
        if (current !== epoch) return;
        view = refreshed;
        list = view.contexts.length === 3;
        selected = defaultReplacement({ ...view, meta: {} });
      } catch {
        /* retain error */
      }
    } finally {
      if (current === epoch) {
        busy = false;
        render();
      }
    }
  }
  async function open(token: Token) {
    const current = ++epoch;
    active = token;
    busy = true;
    list = false;
    message = "";
    view = { exists: false, fields: {}, contexts: [] };
    card.hidden = false;
    render();
    try {
      const result = await request("read");
      if (current !== epoch) return;
      view = result;
    } catch (e) {
      if (current !== epoch) return;
      message = (e as Error).message;
    } finally {
      if (current === epoch) {
        busy = false;
        render();
      }
    }
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
  document.addEventListener("click", (e) => {
    if (!e.composedPath().includes(root.host)) close();
  });
  return { open, close };
}
