import { createDrawer } from "./drawer";
import { DynamicReading } from "./dynamic-reading";
import { fullCard } from "./full-card";
import { normalizeKey } from "./key";
import { containsPoint, excluded, type Token } from "./reading";
import { check, settings, t } from "./shared";
import {
  gloss,
  hitTest,
  type ReadingSettings,
  type HighlightStyle,
} from "./reading";
(() => {
  if (document.getElementById("voka-drawer")) {
    document.dispatchEvent(new Event("voka-refresh"));
    return;
  }
  const host = document.createElement("div");
  host.id = "voka-drawer";
  host.style.cssText =
    "all:initial;position:fixed;bottom:0;right:16px;z-index:2147483647";
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent =
    ":host{color-scheme:light}section{font:14px system-ui,sans-serif;background:#fff;color:#17212b;border:1px solid #ccd3dc;border-radius:12px 12px 0 0;padding:12px 16px;box-shadow:0 2px 16px #0002;display:flex;gap:16px;align-items:center}button{font:inherit;padding:5px 12px;cursor:pointer}";
  const drawer = document.createElement("section");
  drawer.setAttribute("aria-label", "VOKA");
  const summary = document.createElement("span");
  summary.setAttribute("role", "status");
  const retry = document.createElement("button");
  retry.textContent = t("retry");
  const drawerUI = createDrawer(root, summary, retry, (token) => {
    token.range.startContainer.parentElement?.scrollIntoView({
      block: "center",
      behavior: "instant",
    });
    // A card implementation claims this event by calling preventDefault().
    const unclaimed = document.dispatchEvent(
      new CustomEvent("voka-open-card", {
        detail: { token },
        cancelable: true,
      }),
    );
    if (unclaimed && registry && HighlightCtor) {
      registry.set("voka-flash", new HighlightCtor(token.range));
      setTimeout(() => registry.delete("voka-flash"), 900);
    }
  });
  const tooltip = document.createElement("div");
  tooltip.setAttribute("role", "tooltip");
  tooltip.hidden = true;
  tooltip.style.cssText =
    "position:fixed;pointer-events:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:calc(100vw - 24px);padding:7px 10px;border-radius:6px;background:#17212b;color:white;font:14px system-ui;box-shadow:0 2px 10px #0003";
  root.append(tooltip);
  const pageStyle = document.createElement("style");
  pageStyle.textContent =
    "::highlight(voka-flash){background:#ffad45;color:inherit}::highlight(voka-target){background:#ffe89a;color:inherit}::highlight(voka-learning){background:#c9e4ff;color:inherit}::highlight(voka-unknown){background:#ffc9c9;color:inherit}::highlight(voka-weak){background:#fff4cf;color:inherit}";
  host.append(pageStyle);
  type Registry = Map<string, unknown>;
  const registry = (CSS as unknown as { highlights: Registry }).highlights;
  const HighlightCtor = (
    globalThis as unknown as { Highlight: new (...ranges: Range[]) => unknown }
  ).Highlight;
  const styles: HighlightStyle[] = ["target", "learning", "unknown", "weak"];
  let session: DynamicReading | undefined;
  let config: ReadingSettings;
  let running = false,
    generation = 0;
  const choices = new Map<string, { key: string; entry: Token["entry"] }>();
  const card = fullCard(
    root,
    () => config,
    (key, fields) => {
      if (!session) return;
      session.states[key] = {
        ...session.states[key],
        fields,
        cards: session.states[key]?.cards || [],
      };
      for (const token of session.tokens)
        if (token.key === key) {
          token.recognized = true;
          token.entry.lemma = fields.Word || token.entry.lemma;
        }
      // Manual judgments change the highlight immediately; a save does not.
      session.refresh(key);
      drawerUI.update(session.tokens, config);
    },
    (key) => session?.states[key],
    async (token, entry) => {
      const current = session;
      if (!current) return;
      const key = normalizeKey(entry.lemma);
      const response = await chrome.runtime.sendMessage({ type: "page-states", keys: [key] });
      if (response.error) throw new Error(response.error);
      if (current !== session) return;
      Object.assign(current.states, response.data);
      const surface = token.range.toString().toLowerCase();
      choices.set(surface, { key, entry });
      current.choose(surface, { key, entry });
      tooltip.hidden = true;
    },
  );
  const interactive = (event: MouseEvent) =>
    event
      .composedPath()
      .some(
        (n) =>
          n instanceof Element &&
          n.matches(
            'a,button,input,select,textarea,[role="button"],[role="link"],#voka-drawer',
          ),
      );
  function openAt(event: MouseEvent, all: boolean) {
    if (!running || interactive(event)) return;
    const candidates =
      session?.tokensFor(
        event.target instanceof Element ? event.target : null,
      ) ?? [];
    const token = candidates.find(
      (t) =>
        (all || t.style !== null) &&
        t.range.startContainer.isConnected &&
        !excluded(t.range.startContainer.parentElement) &&
        Array.from(t.range.getClientRects()).some((r) =>
          containsPoint(r, event.clientX, event.clientY),
        ),
    );
    if (token) {
      tooltip.hidden = true;
      void card.open(token);
    }
  }
  document.addEventListener("click", (event) => openAt(event, false));
  document.addEventListener("dblclick", (event) => openAt(event, true));
  document.addEventListener("voka-open-card", (event) => {
    if (!running) return;
    const token = (event as CustomEvent<{ token: Token }>).detail?.token;
    if (!token) return;
    event.preventDefault();
    token.range.startContainer.parentElement?.scrollIntoView({
      block: "center",
    });
    void card.open(token);
  });
  function clear() {
    card.close();
    running = false;
    session?.stop();
    session = undefined;
    registry?.delete("voka-flash");
    drawerUI.update([], config, "unreachable");
    tooltip.hidden = true;
    for (const name of styles) registry?.delete("voka-" + name);
  }
  document.addEventListener("mousemove", (event) => {
    const token = running
      ? hitTest(
          session?.tokensFor(
            event.target instanceof Element ? event.target : null,
          ) ?? [],
          event.clientX,
          event.clientY,
          config.hoverScope,
        )
      : undefined;
    tooltip.hidden = !token;
    if (!token) return;
    // Note fields are HTML in Anki. Decode in an inert document, then render text only.
    const inert = document.createElement("template");
    const state = session?.states[token.key];
    const value = gloss(token, config, state);
    inert.innerHTML = state ? value : "";
    const text =
      (state ? (inert.content.textContent ?? "") : value) ||
      (token.entry.dictionaryStatus === "missing"
        ? t("dictionaryMissing")
        : "");
    tooltip.textContent =
      token.entry.lemma + " · " + text.replace(/\s+/g, " ").trim();
    tooltip.style.left =
      Math.max(
        12,
        Math.min(event.clientX, innerWidth - tooltip.offsetWidth - 12),
      ) + "px";
    tooltip.style.top =
      Math.max(
        12,
        Math.min(event.clientY + 20, innerHeight - tooltip.offsetHeight - 12),
      ) + "px";
  });
  document.addEventListener("mouseleave", () => {
    tooltip.hidden = true;
  });
  window.addEventListener(
    "scroll",
    () => {
      tooltip.hidden = true;
    },
    true,
  );
  const observer = new MutationObserver((records) => {
    const changed = records.filter(
      (r) => !host.contains(r.target) && r.target !== host,
    );
    if (!session || !changed.length) return;
    tooltip.hidden = true;
    session.update(changed);
  });
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: [
      "hidden",
      "aria-hidden",
      "contenteditable",
      "style",
      "class",
      "role",
    ],
  });
  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === "local") void refresh();
  });
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "connection-lost") {
      ++generation;
      clear();
      summary.textContent = t("notRunning");
      retry.hidden = false;
      retry.disabled = false;
    }
  });
  async function refresh() {
    const epoch = ++generation;
    clear();
    retry.disabled = true;
    drawerUI.update([], config, "checking");
    let status;
    try {
      status = await check();
    } catch {
      status = "unreachable";
    }
    if (status === "ok") {
      try {
        config = await settings();
        if (!registry || !HighlightCtor)
          throw new Error("Highlight API unavailable");
        if (epoch !== generation) return;
        const highlights = Object.fromEntries(
          styles.map((name) => {
            const highlight = new HighlightCtor() as {
              add(range: Range): void;
              delete(range: Range): void;
            };
            registry.set("voka-" + name, highlight);
            return [name, highlight];
          }),
        ) as Record<
          HighlightStyle,
          { add(range: Range): void; delete(range: Range): void }
        >;
        session = new DynamicReading(
          config,
          highlights,
          async (keys) => {
            const states = {};
            for (let start = 0; start < keys.length; start += 1000) {
              const response = await chrome.runtime.sendMessage({
                type: "page-states",
                keys: keys.slice(start, start + 1000),
              });
              if (response.error) throw new Error(response.error);
              Object.assign(states, response.data);
            }
            return states;
          },
          () => {
            if (epoch !== generation) return;
            clear();
            summary.textContent = t("notRunning");
            retry.hidden = false;
          },
          (tokens) => drawerUI.update(tokens, config),
          async (words) => {
            const matches = {};
            for (let start = 0; start < words.length; start += 1000) {
              const response = await chrome.runtime.sendMessage({
                type: "recognize-words",
                words: words.slice(start, start + 1000),
              });
              if (response.error) throw new Error(response.error);
              for (const [word, match] of Object.entries(response.data))
                Object.assign(matches, { [word]: { ...(match as object), ...choices.get(word.toLowerCase()) } });
            }
            return matches;
          },
        );
        await session.start(document.body);
        if (epoch === generation) running = true;
      } catch {
        status = "unreachable";
        if (epoch === generation) clear();
      }
    }
    if (epoch !== generation) return;
    drawerUI.update(session?.tokens ?? [], config, status);
    retry.hidden = status === "ok";
    retry.disabled = false;
  }
  document.addEventListener("voka-refresh", () => void refresh());
  retry.addEventListener("click", refresh);
  drawer.append(drawerUI.header, drawerUI.body);
  root.append(style, drawer);
  document.documentElement.append(host);
  void refresh();
})();
