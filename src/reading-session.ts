import { createDrawer } from "./drawer";
import { DynamicReading } from "./dynamic-reading";
import { fullCard } from "./full-card";
import { createReviewUI } from "./review-ui";
import {
  createHighlightRegistry,
  type HighlightSet,
} from "./highlight-registry";
import { normalizeKey } from "./key";
import {
  containsPoint,
  dueMarker,
  excluded,
  gloss,
  hitTest,
  highlightRule,
  isDueToday,
  type HighlightStyle,
  type ReadingSettings,
  type Token,
  type WordState,
} from "./reading";
import { check, settings, t } from "./shared";
import { extractFromStream, type TextStreamSource } from "./text-stream";

export type ReadingSourceOptions = {
  /** Keep this source available for reading interactions without listing its words. */
  listed?: false;
  /** Activate a listed token without scrolling to its DOM range. */
  activate?: (token: Token) => void;
  /** Optional source-specific detail shown beside a listed word. */
  detail?: (token: Token) => string | undefined;
};

export type ReadingSource =
  | (ReadingSourceOptions & { kind: "dom"; root: Element })
  | (ReadingSourceOptions & {
      kind: "stream";
      id: string;
      text: () => string;
      rangeFor: (start: number, end: number) => Range;
      document: Document;
    });

export type ReadingSentence = { text: string; html: string };

export type ReadingSessionOptions = {
  uiDocument: Document;
  sources: ReadingSource[];
  sourceLabel?: () => { site: string; title: string };
  sourceLabelForToken?: (
    token: Token,
    storeFullUrl: boolean,
    source?: ReadingSource,
  ) => { site: string; title: string } | undefined;
  sentenceForToken?: (token: Token) => ReadingSentence | undefined;
  drawerNote?: () => string | undefined;
};

export const READING_HIGHLIGHT_CSS =
  "::highlight(voka-flash){background:#ffad45;color:inherit}::highlight(voka-target){background:#ffe89a;color:inherit}::highlight(voka-learning){background:#c9e4ff;color:inherit}::highlight(voka-unknown){background:#ffc9c9;color:inherit}::highlight(voka-weak){background:#fff4cf;color:inherit}::highlight(voka-due){text-decoration:underline solid 2px;text-underline-offset:3px}";

type Match = {
  key: string;
  entry: Token["entry"];
  candidates?: Token["entry"][];
};

type DocumentHighlights = {
  registry: ReturnType<typeof createHighlightRegistry>;
  styles: Record<HighlightStyle, HighlightSet>;
  due: HighlightSet;
};

type SourceController = {
  source: ReadingSource;
  document: Document;
  tokens: Token[];
  reading?: DynamicReading;
  observer?: MutationObserver;
};

const highlightStyles: HighlightStyle[] = [
  "target",
  "learning",
  "unknown",
  "weak",
];

function sourceDocument(source: ReadingSource): Document {
  return source.kind === "dom" ? source.root.ownerDocument : source.document;
}

function sameSource(left: ReadingSource, right: ReadingSource) {
  if (left.kind !== right.kind) return false;
  return left.kind === "dom" && right.kind === "dom"
    ? left.root === right.root
    : left.kind === "stream" &&
        right.kind === "stream" &&
        left.id === right.id;
}

/** Owns the UI and reading lifecycle shared by DOM and text-stream readers. */
export function createReadingSession(options: ReadingSessionOptions) {
  const { uiDocument } = options;
  const sources = options.sources.filter(
    (source, index, all) =>
      all.findIndex((candidate) => sameSource(source, candidate)) === index,
  );
  const sourceLabel = options.sourceLabel;
  const refreshOnStorageKeys = new Set([
    "port",
    "apiKey",
    "nativeLanguage",
    "glossLanguage",
    "targetLevel",
    "showAdvanced",
    "hoverScope",
    "storeFullUrl",
  ]);

  const host = uiDocument.createElement("div");
  host.id = "voka-drawer";
  host.style.cssText =
    "all:initial;position:fixed;bottom:0;right:16px;z-index:2147483647";
  const root = host.attachShadow({ mode: "open" });
  const style = uiDocument.createElement("style");
  style.textContent =
    ":host{color-scheme:light}section{font:14px system-ui,sans-serif;background:#fff;color:#17212b;border:1px solid #ccd3dc;border-radius:12px 12px 0 0;padding:12px 16px;box-shadow:0 2px 16px #0002;display:flex;gap:16px;align-items:center}button{font:inherit;padding:5px 12px;cursor:pointer}";
  const drawer = uiDocument.createElement("section");
  drawer.setAttribute("aria-label", "VOKA");
  const summary = uiDocument.createElement("span");
  summary.setAttribute("role", "status");
  const retry = uiDocument.createElement("button");
  retry.textContent = t("retry");

  const tooltip = uiDocument.createElement("div");
  tooltip.setAttribute("role", "tooltip");
  tooltip.hidden = true;
  tooltip.style.cssText =
    "position:fixed;pointer-events:auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:calc(100vw - 24px);padding:7px 10px;border-radius:6px;background:#17212b;color:white;font:14px system-ui;box-shadow:0 2px 10px #0003";
  const pageStyle = uiDocument.createElement("style");
  pageStyle.textContent = READING_HIGHLIGHT_CSS;
  host.append(pageStyle);

  let config: ReadingSettings & { storeFullUrl?: boolean };
  let drawerUI: ReturnType<typeof createDrawer>;
  let paused = false;
  let running = false;
  let generation = 0;
  let lastDueReadAt = 0;
  let controllers: SourceController[] = [];
  const highlightsByDocument = new Map<Document, DocumentHighlights>();
  const states: Record<string, WordState> = {};
  const known = new Set<string>();
  const resolved = new Map<string, Match>();
  const choices = new Map<string, Match>();
  const documentListeners = new Map<
    Document,
    {
      click: (event: MouseEvent) => void;
      dblclick: (event: MouseEvent) => void;
      mousemove: (event: MouseEvent) => void;
      mouseleave: () => void;
      scroll: () => void;
    }
  >();
  const flashTimers = new Map<Document, number>();

  function highlightsFor(doc: Document): DocumentHighlights {
    const current = highlightsByDocument.get(doc);
    if (current) return current;
    const registry = createHighlightRegistry(doc);
    if (!registry.available) throw new Error("Highlight API unavailable");
    const styles = Object.fromEntries(
      highlightStyles.map((name) => [
        name,
        registry.set("voka-" + name),
      ]),
    ) as Record<HighlightStyle, HighlightSet>;
    const due = registry.set("voka-due");
    const groups = { registry, styles, due };
    highlightsByDocument.set(doc, groups);
    return groups;
  }

  function allTokens() {
    return controllers.flatMap((controller) => controller.tokens);
  }

  function listedTokens() {
    return controllers
      .filter((controller) => controller.source.listed !== false)
      .flatMap((controller) => controller.tokens);
  }

  function sourceForToken(token: Token) {
    return controllers.find((controller) => controller.tokens.includes(token))
      ?.source;
  }

  function updateDrawer(status = "ok") {
    drawerUI?.update(listedTokens(), config, status);
  }

  function syncState(key: string) {
    const state = states[key];
    for (const controller of controllers) {
      if (controller.reading && state) controller.reading.states[key] = state;
      if (controller.reading && !state) delete controller.reading.states[key];
    }
  }

  function syncAllStates(reading: DynamicReading) {
    for (const [key, state] of Object.entries(reading.states)) states[key] = state;
    for (const key of Object.keys(reading.states)) syncState(key);
  }

  async function requestStateData(keys: string[]) {
    const missing = [...new Set(keys)].filter((key) => !known.has(key));
    for (let start = 0; start < missing.length; start += 1000) {
      const response = await chrome.runtime.sendMessage({
        type: "page-states",
        keys: missing.slice(start, start + 1000),
      });
      if (response?.error) throw new Error(response.error);
      Object.assign(states, response?.data ?? {});
    }
    missing.forEach((key) => known.add(key));
    for (const key of missing) syncState(key);
    return Object.fromEntries(
      [...new Set(keys)]
        .filter((key) => states[key])
        .map((key) => [key, states[key]]),
    ) as Record<string, WordState>;
  }

  async function resolveWords(words: string[]) {
    const missing = [...new Set(words)].filter((word) => !resolved.has(word));
    for (let start = 0; start < missing.length; start += 1000) {
      const response = await chrome.runtime.sendMessage({
        type: "recognize-words",
        words: missing.slice(start, start + 1000),
      });
      if (response?.error) throw new Error(response.error);
      for (const [word, rawMatch] of Object.entries(
        response?.data ?? {},
      )) {
        const match = {
          ...(rawMatch as Match),
          ...choices.get(word.toLowerCase()),
        };
        resolved.set(word, match);
      }
    }
    return Object.fromEntries(
      words.flatMap((word) => {
        const match = resolved.get(word);
        return match ? [[word, match]] : [];
      }),
    );
  }

  function clearTokenHighlights(controller: SourceController) {
    const groups = highlightsByDocument.get(controller.document);
    if (!groups) return;
    for (const token of controller.tokens) {
      if (token.style) groups.styles[token.style].delete(token.range);
      if (token.dueMarked) groups.due.delete(token.range);
    }
  }

  function applyStreamToken(token: Token, groups: DocumentHighlights) {
    if (token.style) groups.styles[token.style].delete(token.range);
    if (token.dueMarked) groups.due.delete(token.range);
    const state = states[token.key];
    token.state = state;
    if (state) {
      token.recognized = true;
      token.entry = {
        ...token.entry,
        lemma: state.fields.Word || token.entry.lemma,
      };
    }
    token.style = highlightRule(token.entry.level || state?.level, config, state);
    if (token.style) groups.styles[token.style].add(token.range);
    token.dueMarked = dueMarker(token.entry.level, config, state);
    if (token.dueMarked) groups.due.add(token.range);
  }

  function refreshStreamKey(key: string) {
    for (const controller of controllers) {
      if (controller.source.kind !== "stream") continue;
      const groups = highlightsByDocument.get(controller.document);
      if (!groups) continue;
      for (const token of controller.tokens)
        if (token.key === key) applyStreamToken(token, groups);
    }
  }

  async function refreshStream(controller: SourceController, epoch: number) {
    clearTokenHighlights(controller);
    const source = controller.source;
    if (source.kind !== "stream") return;
    const stream: TextStreamSource = {
      document: source.document,
      text: source.text(),
      rangeFor: source.rangeFor,
    };
    const tokens = extractFromStream(stream);
    controller.tokens = tokens;
    const matches = await resolveWords(
      [...new Set(tokens.map((token) => token.entry.lemma))],
    );
    if (epoch !== generation || !running) return;
    for (const token of tokens) {
      const surface = token.entry.lemma;
      const match = choices.get(surface.toLowerCase()) ?? matches[surface];
      if (match) {
        token.key = match.key;
        token.entry = match.entry;
        token.candidates = match.candidates;
        token.recognized = true;
      }
    }
    const statesByKey = await requestStateData(
      [...new Set(tokens.map((token) => token.key))],
    );
    if (epoch !== generation || !running) return;
    Object.assign(states, statesByKey);
    const groups = highlightsFor(controller.document);
    for (const token of tokens) applyStreamToken(token, groups);
    updateDrawer();
  }

  function setControllerTokens(controller: SourceController, tokens: Token[]) {
    controller.tokens = tokens;
    if (controller.reading) syncAllStates(controller.reading);
    updateDrawer();
  }

  function coordsInUI(doc: Document, x: number, y: number) {
    let current = doc;
    let left = x;
    let top = y;
    while (current !== uiDocument) {
      const frame = current.defaultView?.frameElement as HTMLIFrameElement | null;
      if (!frame) break;
      const bounds = frame.getBoundingClientRect();
      left += bounds.left;
      top += bounds.top;
      current = frame.ownerDocument;
    }
    return { x: left, y: top };
  }

  function tokensForDocument(doc: Document, target: Element | null) {
    return controllers
      .filter((controller) => controller.document === doc)
      .flatMap((controller) =>
        controller.source.kind === "dom" && controller.reading && target
          ? controller.reading.tokensFor(target)
          : controller.tokens,
      );
  }

  function interactive(event: MouseEvent) {
    return event.composedPath().some(
      (node) =>
        (node as Node).nodeType === 1 &&
        (node as Element).matches(
          'a,button,input,select,textarea,[role="button"],[role="link"],#voka-drawer',
        ),
    );
  }

  function openAt(doc: Document, event: MouseEvent, all: boolean) {
    if (!running || interactive(event)) return;
    const target =
      (event.target as Node | null)?.nodeType === 1
        ? (event.target as Element)
        : null;
    const token = tokensForDocument(doc, target).find(
      (candidate) =>
        (all || candidate.style !== null || candidate.dueMarked === true) &&
        candidate.range.startContainer.isConnected &&
        !excluded(candidate.range.startContainer.parentElement) &&
        Array.from(candidate.range.getClientRects()).some((rect) =>
          containsPoint(rect, event.clientX, event.clientY),
        ),
    );
    if (token) {
      tooltip.hidden = true;
      void card.open(token);
    }
  }

  function showTooltip(doc: Document, event: MouseEvent) {
    const target =
      (event.target as Node | null)?.nodeType === 1
        ? (event.target as Element)
        : null;
    const token = running
      ? hitTest(
          tokensForDocument(doc, target),
          event.clientX,
          event.clientY,
          config.hoverScope,
        )
      : undefined;
    tooltip.hidden = !token;
    if (!token) return;
    const inert = uiDocument.createElement("template");
    const state = states[token.key];
    const value = gloss(token, config, state);
    inert.innerHTML = state ? value : "";
    const text =
      (state ? (inert.content.textContent ?? "") : value) ||
      (token.entry.dictionaryStatus === "missing" ? t("dictionaryMissing") : "");
    tooltip.replaceChildren();
    tooltip.append(
      uiDocument.createTextNode(
        token.entry.lemma + " · " + text.replace(/\s+/g, " ").trim(),
      ),
    );
    if (isDueToday(state)) {
      const badge = uiDocument.createElement("span");
      badge.textContent = t("dueToday");
      badge.style.cssText =
        "display:inline-block;margin-left:8px;padding:1px 6px;border-radius:10px;background:#fff;color:#17212b;font-size:11px";
      tooltip.append(badge);
    }
    const position = coordsInUI(doc, event.clientX, event.clientY);
    const win = uiDocument.defaultView;
    const width = win?.innerWidth ?? 0;
    const height = win?.innerHeight ?? 0;
    tooltip.style.left =
      Math.max(12, Math.min(position.x, width - tooltip.offsetWidth - 12)) +
      "px";
    tooltip.style.top =
      Math.max(
        12,
        Math.min(position.y + 20, height - tooltip.offsetHeight - 12),
      ) + "px";
  }

  function attachDocument(doc: Document) {
    if (documentListeners.has(doc)) return;
    const listeners = {
      click: (event: MouseEvent) => openAt(doc, event, false),
      dblclick: (event: MouseEvent) => openAt(doc, event, true),
      mousemove: (event: MouseEvent) => showTooltip(doc, event),
      mouseleave: () => {
        tooltip.hidden = true;
      },
      scroll: () => {
        tooltip.hidden = true;
      },
    };
    doc.addEventListener("click", listeners.click);
    doc.addEventListener("dblclick", listeners.dblclick);
    doc.addEventListener("mousemove", listeners.mousemove);
    doc.addEventListener("mouseleave", listeners.mouseleave);
    doc.defaultView?.addEventListener("scroll", listeners.scroll, true);
    documentListeners.set(doc, listeners);
  }

  function detachDocument(doc: Document) {
    const listeners = documentListeners.get(doc);
    if (!listeners) return;
    doc.removeEventListener("click", listeners.click);
    doc.removeEventListener("dblclick", listeners.dblclick);
    doc.removeEventListener("mousemove", listeners.mousemove);
    doc.removeEventListener("mouseleave", listeners.mouseleave);
    doc.defaultView?.removeEventListener("scroll", listeners.scroll, true);
    documentListeners.delete(doc);
  }

  function attachObserver(controller: SourceController, epoch: number) {
    if (controller.source.kind !== "dom") return;
    const rootNode = controller.document.documentElement ?? controller.source.root;
    const MutationObserverConstructor =
      controller.document.defaultView?.MutationObserver ?? MutationObserver;
    controller.observer = new MutationObserverConstructor((records) => {
      const rootElement = controller.source.kind === "dom" ? controller.source.root : null;
      const relevant = records.filter((record) => {
        if (host.contains(record.target) || record.target === host) return false;
        if (!rootElement) return false;
        if (rootElement.contains(record.target)) return true;
        return (
          record.type === "attributes" &&
          record.target.nodeType === 1 &&
          (record.target as Element).contains(rootElement)
        );
      });
      if (!relevant.length || !controller.reading || epoch !== generation) return;
      tooltip.hidden = true;
      controller.reading.update(relevant);
    });
    controller.observer.observe(rootNode, {
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
  }

  function clearRegistry(doc: Document, groups: DocumentHighlights) {
    for (const name of [
      ...highlightStyles.map((styleName) => "voka-" + styleName),
      "voka-due",
      "voka-flash",
    ])
      groups.registry.clear(name);
    const timer = flashTimers.get(doc);
    if (timer !== undefined) uiDocument.defaultView?.clearTimeout(timer);
    flashTimers.delete(doc);
  }

  function removeController(controller: SourceController) {
    controller.observer?.disconnect();
    clearTokenHighlights(controller);
    controller.reading?.stop();
    controllers = controllers.filter((item) => item !== controller);
    if (!controllers.some((item) => item.document === controller.document)) {
      const groups = highlightsByDocument.get(controller.document);
      if (groups) clearRegistry(controller.document, groups);
      highlightsByDocument.delete(controller.document);
      detachDocument(controller.document);
    }
    updateDrawer();
  }

  function clearControllers() {
    for (const controller of controllers) {
      controller.observer?.disconnect();
      clearTokenHighlights(controller);
      controller.reading?.stop();
    }
    controllers = [];
    for (const [doc, groups] of highlightsByDocument) clearRegistry(doc, groups);
    highlightsByDocument.clear();
    states && Object.keys(states).forEach((key) => delete states[key]);
    known.clear();
    resolved.clear();
  }

  const reviewUI = createReviewUI(
    root,
    () => config,
    () => drawerUI.showList(),
    () => void refresh(),
  );

  drawerUI = createDrawer(
    root,
    summary,
    retry,
    (token) => {
      const source = sourceForToken(token);
      if (source?.activate) source.activate(token);
      else
        token.range.startContainer.parentElement?.scrollIntoView({
          block: "center",
          behavior: "instant",
        });
      const event = new CustomEvent("voka-open-card", {
        detail: { token },
        cancelable: true,
      });
      const unclaimed = uiDocument.dispatchEvent(event);
      if (unclaimed) {
        const doc = token.range.startContainer.ownerDocument ?? uiDocument;
        const groups = highlightsFor(doc);
        groups.registry.set("voka-flash", [token.range]);
        const oldTimer = flashTimers.get(doc);
        if (oldTimer !== undefined) uiDocument.defaultView?.clearTimeout(oldTimer);
        const timer = uiDocument.defaultView?.setTimeout(() => {
          groups.registry.clear("voka-flash");
          flashTimers.delete(doc);
        }, 900);
        if (timer !== undefined) flashTimers.set(doc, timer);
      }
    },
    () => {
      if (running && lastDueReadAt && Date.now() - lastDueReadAt > 5 * 60 * 1000)
        void refresh();
    },
    (tokens) => reviewUI.start(tokens),
    reviewUI.element,
    (token, cardId) => reviewUI.practice(token, cardId),
    {
      note: options.drawerNote,
      detail: (token) => sourceForToken(token)?.detail?.(token),
    },
  );
  root.append(tooltip);

  const card = fullCard(
    root,
    () => config,
    (key, fields) => {
      states[key] = {
        ...states[key],
        fields,
        cards: states[key]?.cards || [],
      };
      syncState(key);
      for (const token of allTokens())
        if (token.key === key) {
          token.recognized = true;
          token.entry.lemma = fields.Word || token.entry.lemma;
        }
      for (const controller of controllers) controller.reading?.refresh(key);
      refreshStreamKey(key);
      updateDrawer();
    },
    (key) => states[key],
    async (token, entry) => {
      const epoch = generation;
      const surface = token.range.toString().toLowerCase();
      const key = normalizeKey(entry.lemma);
      const response = await chrome.runtime.sendMessage({
        type: "page-states",
        keys: [key],
      });
      if (response?.error) throw new Error(response.error);
      if (epoch !== generation) return;
      Object.assign(states, response?.data ?? {});
      known.add(key);
      syncState(key);
      const match = { key, entry };
      choices.set(surface, match);
      resolved.set(surface, match);
      for (const controller of controllers) {
        if (controller.reading) {
          controller.reading.choose(surface, match);
        } else {
          for (const candidate of controller.tokens)
            if (candidate.range.toString().toLowerCase() === surface) {
              candidate.key = key;
              candidate.entry = entry;
              candidate.recognized = true;
              candidate.candidates = undefined;
              if (controller.source.kind === "stream")
                applyStreamToken(
                  candidate,
                  highlightsFor(controller.document),
                );
            }
        }
      }
      updateDrawer();
      tooltip.hidden = true;
    },
    (token) =>
      options.sourceLabelForToken?.(
        token,
        config?.storeFullUrl === true,
        sourceForToken(token),
      ) ??
      sourceLabel?.(),
    (token) => options.sentenceForToken?.(token),
    (token) => sourceForToken(token)?.listed !== false,
  );

  function handleDisconnect() {
    ++generation;
    clearControllers();
    card.close();
    running = false;
    drawerUI.update([], config, "unreachable");
    summary.textContent = t("notRunning");
    retry.hidden = false;
    retry.disabled = false;
    tooltip.hidden = true;
  }

  async function startController(source: ReadingSource, epoch: number) {
    const doc = sourceDocument(source);
    const controller: SourceController = { source, document: doc, tokens: [] };
    controllers.push(controller);
    attachDocument(doc);
    const groups = highlightsFor(doc);
    if (source.kind === "dom") {
      controller.reading = new DynamicReading(
        config,
        groups.styles,
        requestStateData,
        handleDisconnect,
        (tokens) => setControllerTokens(controller, tokens),
        resolveWords,
        groups.due,
      );
      attachObserver(controller, epoch);
      await controller.reading.start(source.root);
      if (epoch !== generation || !running) return;
    } else {
      await refreshStream(controller, epoch);
    }
  }

  async function refresh() {
    paused = false;
    const epoch = ++generation;
    clearControllers();
    card.close();
    running = false;
    retry.disabled = true;
    drawerUI.update([], config, "checking");
    tooltip.hidden = true;
    let status: string;
    try {
      status = await check();
    } catch {
      status = "unreachable";
    }
    if (epoch !== generation) return;
    if (status === "ok") {
      try {
        config = await settings();
        if (epoch !== generation) return;
        running = true;
        for (const source of sources) await startController(source, epoch);
        if (epoch !== generation) return;
        lastDueReadAt = Date.now();
        void drawerUI.checkUpgrade();
      } catch {
        status = "unreachable";
        if (epoch === generation) {
          clearControllers();
          running = false;
        }
      }
    }
    if (epoch !== generation) return;
    drawerUI.update(listedTokens(), config, status);
    retry.hidden = status === "ok";
    retry.disabled = false;
  }

  function onOpenCard(event: Event) {
    if (!running) return;
    const token = (event as CustomEvent<{ token: Token }>).detail?.token;
    if (!token) return;
    event.preventDefault();
    if (!sourceForToken(token)?.activate)
      token.range.startContainer.parentElement?.scrollIntoView({
        block: "center",
      });
    void card.open(token);
  }

  function onRuntimeMessage(
    message: { type?: string } | undefined,
    _sender: chrome.runtime.MessageSender,
    reply: (response?: unknown) => void,
  ) {
    if (message?.type === "pause-reading") {
      paused = true;
      ++generation;
      clearControllers();
      card.close();
      running = false;
      drawerUI.update([], config, "unreachable");
      summary.textContent = t("popupPaused");
      retry.hidden = true;
      tooltip.hidden = true;
      reply({ ok: true });
    }
    if (message?.type === "connection-lost" && !paused) handleDisconnect();
  }

  uiDocument.addEventListener("voka-open-card", onOpenCard);
  retry.addEventListener("click", () => void refresh());
  chrome.storage.onChanged.addListener((changes, area) => {
    if (
      area === "local" &&
      !paused &&
      Object.keys(changes).some((key) => refreshOnStorageKeys.has(key))
    )
      void refresh();
  });
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  drawer.append(drawerUI.header, drawerUI.body);
  root.append(style, drawer);
  uiDocument.documentElement.append(host);

  function addSource(source: ReadingSource) {
    if (sources.some((candidate) => sameSource(candidate, source))) return;
    sources.push(source);
    if (running) {
      const epoch = generation;
      void startController(source, epoch).catch(handleDisconnect);
    }
  }

  function removeSource(source: ReadingSource) {
    const index = sources.findIndex((candidate) => sameSource(candidate, source));
    if (index < 0) return;
    const [removed] = sources.splice(index, 1);
    const controller = controllers.find((candidate) => candidate.source === removed);
    if (controller) removeController(controller);
  }

  function stop() {
    ++generation;
    clearControllers();
    card.close();
    running = false;
    tooltip.hidden = true;
    drawerUI.update([], config, "unreachable");
  }

  function destroy() {
    stop();
    for (const doc of [...documentListeners.keys()]) detachDocument(doc);
    uiDocument.removeEventListener("voka-open-card", onOpenCard);
    chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    uiDocument.defaultView?.removeEventListener("unload", destroy);
    host.remove();
  }

  uiDocument.defaultView?.addEventListener("unload", destroy, { once: true });

  return {
    start: refresh,
    stop,
    refresh,
    addSource,
    removeSource,
    refreshDrawer: () => updateDrawer(),
    isRunning: () => running,
    getHoverZones: () => {
      const fullCard = root.querySelector("#voka-card");
      return fullCard ? [tooltip, fullCard] : [tooltip];
    },
    destroy,
  };
}
