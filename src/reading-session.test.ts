// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { Window } from "happy-dom";
import { check } from "./shared";

vi.mock("./shared", () => ({
  check: vi.fn(async () => "ok"),
  settings: vi.fn(async () => ({
    nativeLanguage: "zh",
    glossLanguage: "native",
    targetLevel: "A2",
    showAdvanced: false,
    hoverScope: "highlighted",
  })),
  t: (key: string) => key,
}));

import { createReadingSession } from "./reading-session";

function override(target: object, name: string, value: unknown) {
  const original = Object.getOwnPropertyDescriptor(target, name);
  Object.defineProperty(target, name, {
    configurable: true,
    writable: true,
    value,
  });
  return () => {
    if (original) Object.defineProperty(target, name, original);
    else Reflect.deleteProperty(target, name);
  };
}

class TestHighlight {
  ranges = new Set<Range>();
  constructor(...ranges: Range[]) {
    ranges.forEach((range) => this.ranges.add(range));
  }
  add(range: Range) {
    this.ranges.add(range);
  }
  delete(range: Range) {
    this.ranges.delete(range);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("shares one session across an iframe DOM source and a text stream", async () => {
  const mainHighlights = new Map<string, unknown>();
  const iframeHighlights = new Map<string, unknown>();
  const restoreMainCSS = override(window, "CSS", {
    highlights: mainHighlights,
  });
  const restoreMainHighlight = override(window, "Highlight", TestHighlight);

  const iframeWindow = new Window({
    settings: { enableIframePageLoading: true },
  });
  const iframeDoc = iframeWindow.document as unknown as Document;
  const iframe = iframeDoc.createElement("iframe");
  iframeDoc.body.append(iframe);
  const sourceDoc = iframe.contentDocument! as unknown as Document;
  sourceDoc.open();
  sourceDoc.write("<!doctype html><html><body><p>improve</p></body></html>");
  sourceDoc.close();
  const iframeDefaultView = sourceDoc.defaultView!;
  const restoreIframeCSS = override(iframeDefaultView, "CSS", {
    highlights: iframeHighlights,
  });
  const restoreIframeHighlight = override(
    iframeDefaultView,
    "Highlight",
    TestHighlight,
  );

  document.body.innerHTML = "<p id=\"caption\">achieve</p>";
  const caption = document.querySelector("#caption")!.firstChild!;
  const sendMessage = vi.fn(async (message: { type?: string; words?: string[]; keys?: string[] }) => {
    if (message.type === "recognize-words")
      return {
        data: Object.fromEntries(
          (message.words ?? []).map((word) => [
            word,
            {
              key: `en:${word}`,
              entry: {
                lemma: word,
                level: "A2",
                GlossNative: "释义",
                GlossTarget: "meaning",
              },
            },
          ]),
        ),
      };
    if (message.type === "page-states")
      return {
        data: Object.fromEntries(
          (message.keys ?? [])
            .filter((key) => key === "en:improve")
            .map((key) => [
              key,
              {
                fields: { Word: "improve" },
                cards: [
                  {
                    cardId: "due-improve",
                    type: "new",
                    queue: "new",
                    intervalDays: 0,
                    dueToday: true,
                  },
                ],
              },
            ]),
        ),
      };
    if (message.type === "upgrade-summary") return { data: { count: 0 } };
    return { data: {} };
  });
  const runtimeListeners = new Set<(...args: any[]) => void>();
  const storageListeners = new Set<(...args: any[]) => void>();
  vi.stubGlobal("chrome", {
    runtime: {
      getURL: (path: string) => path,
      sendMessage,
      onMessage: {
        addListener: (listener: (...args: any[]) => void) =>
          runtimeListeners.add(listener),
        removeListener: (listener: (...args: any[]) => void) =>
          runtimeListeners.delete(listener),
      },
    },
    storage: {
      onChanged: {
        addListener: (listener: (...args: any[]) => void) =>
          storageListeners.add(listener),
        removeListener: (listener: (...args: any[]) => void) =>
          storageListeners.delete(listener),
      },
      local: { set: vi.fn(async () => {}) },
    },
  });

  const session = createReadingSession({
    uiDocument: document,
    sources: [
      { kind: "dom", root: sourceDoc.body, listed: false },
      {
        kind: "stream",
        id: "caption-1",
        text: () => "achieve",
        rangeFor: (start, end) => {
          const range = document.createRange();
          range.setStart(caption, start);
          range.setEnd(caption, end);
          return range;
        },
        document,
      },
    ],
  });

  try {
    vi.mocked(check).mockClear();
    await session.start();
    expect(check).toHaveBeenCalledTimes(1);
    for (const listener of storageListeners)
      listener({ "reader-position:test": { newValue: {} } }, "local");
    await Promise.resolve();
    expect(check).toHaveBeenCalledTimes(1);
    const host = document.getElementById("voka-drawer")!;
    const listText = host.shadowRoot!.querySelector(".drawer-list")!.textContent;
    expect(listText).toContain("achieve");
    expect(listText).not.toContain("improve");
    expect(
      host.shadowRoot!.querySelector('[data-slot="due-summary"]')!.textContent,
    ).toContain("dueNone");

    const iframeTarget = iframeHighlights.get("voka-target") as TestHighlight;
    const mainTarget = mainHighlights.get("voka-target") as TestHighlight;
    expect([...iframeTarget.ranges].map((range) => range.toString())).toEqual([
      "improve",
    ]);
    expect([...mainTarget.ranges].map((range) => range.toString())).toEqual([
      "achieve",
    ]);
    expect(
      [...iframeTarget.ranges].every(
        (range) => range.startContainer.ownerDocument === sourceDoc,
      ),
    ).toBe(true);
    expect(
      [...mainTarget.ranges].every(
        (range) => range.startContainer.ownerDocument === document,
      ),
    ).toBe(true);

    for (const listener of storageListeners)
      listener({ nativeLanguage: { oldValue: "zh", newValue: "en" } }, "local");
    expect(check).toHaveBeenCalledTimes(2);

    session.stop();
    expect(iframeHighlights.size).toBe(0);
    expect(mainHighlights.size).toBe(0);
  } finally {
    session.stop();
    restoreIframeHighlight();
    restoreIframeCSS();
    restoreMainHighlight();
    restoreMainCSS();
    iframe.remove();
    iframeWindow.close();
  }
});
