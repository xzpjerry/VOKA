// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReadingSource } from "../reading-session";
import {
  buildRefetchUrl,
  chooseEnglishTrack,
  parseJson3,
  type CaptionCue,
} from "./captions";
import {
  acquireCaptions,
  createYouTubeController,
  type YouTubeCaptionAdapter,
} from "./controller";

const cueBody = (text: string) =>
  JSON.stringify({
    events: [
      {
        tStartMs: 500,
        dDurationMs: 1250,
        segs: [{ utf8: text }],
      },
    ],
  });

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("YouTube caption helpers", () => {
  it("parses json3 cues, joins segments, and skips empty events", () => {
    expect(
      parseJson3(
        JSON.stringify({
          events: [
            {
              tStartMs: 125,
              dDurationMs: 950,
              segs: [{ utf8: "hello\n" }, { utf8: " world" }],
            },
            { tStartMs: 2000, dDurationMs: 1000 },
            { tStartMs: 3000, dDurationMs: 1000, segs: [{ utf8: "  " }] },
          ],
        }),
      ),
    ).toEqual([{ startMs: 125, endMs: 1075, text: "hello world" }]);
    expect(parseJson3("not json")).toEqual([]);
  });

  it("prefers human English, then auto English, and skips non-English tracks", () => {
    const auto = { languageCode: "en-US", kind: "asr" };
    const human = { languageCode: "en", kind: "standard" };
    expect(chooseEnglishTrack([{ languageCode: "fr" }, auto, human])).toBe(human);
    expect(chooseEnglishTrack([{ languageCode: "fr" }, auto])).toBe(auto);
    expect(chooseEnglishTrack([{ languageCode: "fr" }])).toBeUndefined();
  });

  it("builds refetch URLs without dropping player tokens or unrelated params", () => {
    const base =
      "https://www.youtube.com/api/timedtext?v=video&pot=proof&c=WEB&ei=e&lang=fr&kind=asr&fmt=srv3&tlang=zh";
    const human = new URL(
      buildRefetchUrl(base, { languageCode: "en" }),
    );
    expect(human.searchParams.get("pot")).toBe("proof");
    expect(human.searchParams.get("c")).toBe("WEB");
    expect(human.searchParams.get("ei")).toBe("e");
    expect(human.searchParams.get("lang")).toBe("en");
    expect(human.searchParams.get("kind")).toBeNull();
    expect(human.searchParams.get("fmt")).toBe("json3");
    expect(human.searchParams.get("tlang")).toBeNull();

    const automatic = new URL(
      buildRefetchUrl(base, { languageCode: "en-US", kind: "asr" }),
    );
    expect(automatic.searchParams.get("lang")).toBe("en-US");
    expect(automatic.searchParams.get("kind")).toBe("asr");
  });
});

describe("caption acquisition order", () => {
  const track = { languageCode: "en" };
  const timed = (lang: string, body: string) => ({
    url: "https://www.youtube.com/api/timedtext?pot=proof&c=WEB",
    lang,
    body,
  });

  it("uses method 1 when the enabled English track returns cues", async () => {
    const order: string[] = [];
    const result = await acquireCaptions(track, {
      waitForTimedText: async () => {
        order.push("wait");
        return timed("en", cueBody("first"));
      },
      enable: async () => void order.push("enable"),
      refetch: async () => {
        order.push("refetch");
        return { ok: true, status: 200, body: cueBody("refetched") };
      },
      readScreen: async () => {
        order.push("screen");
        return [];
      },
    });
    expect(result).toMatchObject({ method: 1, scope: "full-track" });
    expect(result.cues[0].text).toBe("first");
    expect(order).toEqual(["wait", "enable"]);
  });

  it("falls through from a wrong-language response to method 2", async () => {
    const order: string[] = [];
    const result = await acquireCaptions(track, {
      waitForTimedText: async () => {
        order.push("timedtext");
        return timed("fr", cueBody("wrong language"));
      },
      enable: async () => void order.push("enable"),
      refetch: async () => {
        order.push("refetch");
        return { ok: true, status: 200, body: cueBody("english") };
      },
      readScreen: async () => {
        order.push("screen");
        return [];
      },
    });
    expect(result).toMatchObject({ method: 2, scope: "full-track" });
    expect(result.cues[0].text).toBe("english");
    expect(order).toEqual(["timedtext", "enable", "refetch"]);
  });

  it("falls through empty method 1 and method 2 responses to method 3", async () => {
    const order: string[] = [];
    const screen: CaptionCue[] = [{ startMs: 900, endMs: 1800, text: "screen" }];
    const result = await acquireCaptions(track, {
      waitForTimedText: async () => {
        order.push("timedtext");
        return timed("en", JSON.stringify({ events: [] }));
      },
      enable: async () => void order.push("enable"),
      refetch: async () => {
        order.push("refetch");
        return { ok: true, status: 200, body: JSON.stringify({ events: [] }) };
      },
      readScreen: async () => {
        order.push("screen");
        return screen;
      },
    });
    expect(result).toMatchObject({ method: 3, scope: "played-part-only", cues: screen });
    expect(order).toEqual(["timedtext", "enable", "refetch", "screen"]);
  });

  it("uses method 4 when no timed-text or screen cues arrive", async () => {
    const order: string[] = [];
    const result = await acquireCaptions(track, {
      waitForTimedText: async () => {
        order.push("timedtext");
        return undefined;
      },
      enable: async () => void order.push("enable"),
      refetch: async () => {
        order.push("refetch");
        return { ok: true, status: 200, body: "" };
      },
      readScreen: async () => {
        order.push("screen");
        return [];
      },
    });
    expect(result).toMatchObject({ method: 4, scope: "none", error: "TimedTextTimeout" });
    expect(order).toEqual(["timedtext", "enable", "screen"]);
  });

  it("waits for an ad to finish before enabling captions", async () => {
    const order: string[] = [];
    let adShowing = true;
    const result = await acquireCaptions(track, {
      waitForAdEnd: async (_signal, onWaiting) => {
        onWaiting?.(true);
        order.push("wait-ad");
        adShowing = false;
        onWaiting?.(false);
      },
      isAdShowing: () => adShowing,
      waitForTimedText: async () => {
        order.push("wait");
        return timed("en", cueBody("after ad"));
      },
      enable: async () => void order.push("enable"),
      refetch: async () => ({ ok: true, status: 200, body: "" }),
      readScreen: async () => [],
    });
    expect(order).toEqual(["wait-ad", "wait", "enable"]);
    expect(result.method).toBe(1);
  });

  it("uses a resource-timing token when no post-hook request arrives", async () => {
    const result = await acquireCaptions(track, {
      getTokenSource: async () => "resource-timing",
      waitForTimedText: async () => undefined,
      enable: async () => {},
      refetch: async () => ({
        ok: true,
        status: 200,
        body: cueBody("cached English track"),
        tokenSource: "resource-timing",
        responseBytes: 123,
      }),
      readScreen: async () => [],
    });
    expect(result).toMatchObject({
      method: 2,
      tokenSource: "resource-timing",
      httpStatus: 200,
      responseBytes: 123,
    });
    expect(result.cues[0].text).toBe("cached English track");
  });

  it("forces a player refresh at most once for the shared video state", async () => {
    const state = { forcedRefreshUsed: false };
    let waits = 0;
    let disables = 0;
    let reloads = 0;
    const adapter = {
      waitForTimedText: async () => {
        waits++;
        return waits === 3 ? timed("en", cueBody("forced English track")) : undefined;
      },
      enable: async () => {},
      disableCaptions: async () => {
        disables++;
      },
      reloadCaptions: async () => {
        reloads++;
      },
      refetch: async () => ({ ok: true, status: 200, body: "" }),
      readScreen: async () => [],
    };
    const options = {
      state,
      timedTextTimeoutMs: 0,
      forceRefreshDelayMs: 0,
      forceRefreshFirstWaitMs: 0,
      forceRefreshTotalWaitMs: 0,
    };
    const first = await acquireCaptions(track, adapter, options);
    expect(first).toMatchObject({ method: 1 });
    expect(state.forcedRefreshUsed).toBe(true);
    expect(disables).toBe(1);
    expect(reloads).toBe(1);

    const second = await acquireCaptions(track, adapter, options);
    expect(second.method).toBe(4);
    expect(disables).toBe(1);
  });
});

describe("YouTube video lifecycle", () => {
  it("clears old cues and sources before starting the next watch URL", async () => {
    vi.useFakeTimers();
    document.body.innerHTML =
      '<div id="movie_player"><div class="ytp-caption-window-container"><span class="ytp-caption-segment"></span></div></div><video></video>';
    let href = "https://www.youtube.com/watch?v=first";
    const destroyed: number[] = [];
    const sources: ReadingSource[] = [];
    let sessionIndex = 0;
    const createSession = () => {
      const index = sessionIndex++;
      return {
        start: async () => {},
        isRunning: () => true,
        addSource: (source: ReadingSource) => sources.push(source),
        removeSource: (source: ReadingSource) => {
          const at = sources.indexOf(source);
          if (at >= 0) sources.splice(at, 1);
        },
        destroy: () => destroyed.push(index),
      };
    };
    const adapter: YouTubeCaptionAdapter = {
      inject: async () => {},
      tracks: async () => ({ tracks: [{ languageCode: "en" }] }),
      enable: async () => {},
      waitForTimedText: async () => ({
        url: "https://www.youtube.com/api/timedtext?lang=en",
        lang: "en",
        body: cueBody(href.includes("first") ? "first cue" : "second cue"),
      }),
      refetch: async () => ({ ok: true, status: 200, body: "" }),
      readScreen: async () => [],
      getCurrentTime: async () => 0.75,
      readCaptionText: () => "",
      clearTimedTextWaiters: () => {},
      dispose: () => {},
    };
    const controller = createYouTubeController({
      uiDocument: document,
      createSession,
      adapter,
      readHref: () => href,
      diagnosticsEnabled: async () => false,
      timedTextTimeoutMs: 0,
      screenTimeoutMs: 0,
      pollMs: 60000,
    });
    const changes: Array<{ cues: CaptionCue[]; method: number | null }> = [];
    controller.addEventListener("cues-changed", (event) => {
      const detail = (event as CustomEvent<{ cues: CaptionCue[]; method: number | null }>).detail;
      changes.push(detail);
    });
    try {
      await controller.start();
      expect(controller.getCues()[0].text).toBe("first cue");
      expect(sources).toHaveLength(1);

      href = "https://www.youtube.com/watch?v=second";
      await controller.refreshLocation();
      expect(changes.some((change) => change.cues.length === 0 && change.method === null)).toBe(true);
      expect(destroyed).toEqual([0]);
      expect(controller.getCues()[0].text).toBe("second cue");
      expect(sources).toHaveLength(1);
    } finally {
      controller.stop();
    }
  });

  it("retries method 4 once after playback starts", async () => {
    document.body.innerHTML = '<div id="movie_player"></div><video></video>';
    let waitCount = 0;
    let enableCount = 0;
    const adapter: YouTubeCaptionAdapter = {
      inject: async () => {},
      tracks: async () => ({ tracks: [{ languageCode: "en" }] }),
      enable: async () => {
        enableCount++;
      },
      waitForTimedText: async () => {
        waitCount++;
        return waitCount === 2
          ? {
              url: "https://www.youtube.com/api/timedtext?pot=proof&lang=en",
              lang: "en",
              body: cueBody("recovered"),
              status: 200,
              responseBytes: 48,
            }
          : undefined;
      },
      refetch: async () => ({ ok: true, status: 200, body: "" }),
      readScreen: async () => [],
      getCurrentTime: async () => 1,
      readCaptionText: () => "",
      clearTimedTextWaiters: () => {},
      dispose: () => {},
    };
    const controller = createYouTubeController({
      uiDocument: document,
      createSession: () => ({
        start: async () => {},
        isRunning: () => true,
        addSource: () => {},
        removeSource: () => {},
        destroy: () => {},
      }),
      adapter,
      readHref: () => "https://www.youtube.com/watch?v=retry",
      diagnosticsEnabled: async () => false,
      timedTextTimeoutMs: 0,
      screenTimeoutMs: 0,
      pollMs: 60000,
    });
    try {
      await controller.start();
      expect(controller.getMethod()).toBe(4);
      const video = document.querySelector("video")!;
      video.dispatchEvent(new Event("play"));
      video.dispatchEvent(new Event("play"));
      await vi.waitFor(() => expect(controller.getMethod()).toBe(1));
      expect(enableCount).toBe(2);
    } finally {
      controller.stop();
    }
  });
});
