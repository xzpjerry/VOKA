// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Token } from "../reading";
import type { CaptionCue } from "./captions";
import {
  buildTranscriptContainer,
  cueSentence,
  createYouTubeWordPanel,
  formatCueTime,
  youtubeSourceLabel,
} from "./word-panel";

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("YouTube word panel helpers", () => {
  it("builds one extractor-readable paragraph per cue", () => {
    const cues: CaptionCue[] = [
      { startMs: 1250, endMs: 3000, text: "The first cue." },
      { startMs: 8500, endMs: 10000, text: "The second cue." },
    ];
    const transcript = buildTranscriptContainer(document, cues);

    expect(transcript.id).toBe("voka-transcript");
    expect(transcript.style.position).toBe("absolute");
    expect(transcript.style.left).toBe("-100000px");
    expect(transcript.style.top).toBe("0px");
    expect(transcript.style.width).toBe("1px");
    expect(transcript.style.overflow).toBe("hidden");
    expect(transcript.hasAttribute("hidden")).toBe(false);
    expect(transcript.hasAttribute("aria-hidden")).toBe(false);
    expect(
      Array.from(transcript.querySelectorAll("p")).map((paragraph) => [
        paragraph.dataset.startMs,
        paragraph.textContent,
      ]),
    ).toEqual([
      ["1250", "The first cue."],
      ["8500", "The second cue."],
    ]);
    expect(
      Array.from(transcript.querySelectorAll("p")).map(
        (paragraph) => paragraph.dataset.cueIndex,
      ),
    ).toEqual(["0", "1"]);
  });

  it("rebuilds the attached transcript as cues change and labels tokens by cue", () => {
    vi.stubGlobal("chrome", {
      i18n: {
        getMessage: (key: string) =>
          ({
            youtubeScopeWholeVideo: "Whole video",
            youtubeScopePlayedPart: "Played part only",
          })[key] ?? key,
      },
    });
    const controller = new EventTarget() as EventTarget & {
      getCues: () => CaptionCue[];
      getScope: () => "full-track" | "played-part-only" | "none";
      seekTo: (timeSeconds: number) => void;
    };
    let cues: CaptionCue[] = [
      { startMs: 1250, endMs: 3000, text: "The first cue." },
      { startMs: 8500, endMs: 10000, text: "The second cue." },
    ];
    controller.getCues = () => cues;
    controller.getScope = () => "full-track";
    controller.seekTo = () => {};
    const panel = createYouTubeWordPanel(
      document,
      () => "https://www.youtube.com/watch?v=fixture1",
    );
    panel.bind(controller);
    expect(panel.drawerNote()).toBe("Whole video");

    const transcript = document.querySelector("#voka-transcript")!;
    expect(transcript.textContent).toBe("The first cue.The second cue.");
    const firstText = transcript.querySelector("p")!.firstChild!;
    const firstRange = document.createRange();
    firstRange.setStart(firstText, 4);
    firstRange.setEnd(firstText, 9);
    const firstToken = { range: firstRange } as Token;
    expect(panel.sourceLabelForToken(firstToken, false)).toEqual({
      site: "youtube.com",
      title: `${document.title || "YouTube"} · 00:01`,
    });
    expect(panel.sourceLabelForToken(firstToken, true)?.site).toBe(
      "https://www.youtube.com/watch?v=fixture1&t=1s",
    );

    cues = [{ startMs: 65000, endMs: 70000, text: "The replacement cue." }];
    controller.dispatchEvent(
      new CustomEvent("cues-changed", {
        detail: { cues, scope: "played-part-only" },
      }),
    );
    expect(panel.drawerNote()).toBe("Played part only");
    expect(transcript.textContent).toBe("The replacement cue.");

    const subtitle = document.createElement("div");
    subtitle.id = "voka-subtitle";
    subtitle.dataset.startMs = "65000";
    const subtitleText = document.createTextNode("The replacement cue.");
    subtitle.append(subtitleText);
    document.body.append(subtitle);
    const subtitleRange = document.createRange();
    subtitleRange.setStart(subtitleText, 4);
    subtitleRange.setEnd(subtitleText, 15);
    const subtitleToken = { range: subtitleRange } as Token;
    expect(panel.sourceLabelForToken(subtitleToken, false)).toEqual({
      site: "youtube.com",
      title: `${document.title || "YouTube"} · 01:05`,
    });
    controller.dispatchEvent(
      new CustomEvent("cues-changed", {
        detail: { cues: [], scope: "none" },
      }),
    );
    expect(panel.drawerNote()).toBeUndefined();
    expect(document.querySelector("#voka-transcript")).toBeNull();
    panel.stop();
  });

  it("formats first-appearance times as mm:ss", () => {
    expect(formatCueTime(0)).toBe("00:00");
    expect(formatCueTime(65000)).toBe("01:05");
    expect(formatCueTime(3600000)).toBe("60:00");
  });

  it("uses one full cue, and joins neighboring cues when it has fewer than three words", () => {
    const cues: CaptionCue[] = [
      { startMs: 0, endMs: 500, text: "The boat waited." },
      { startMs: 500, endMs: 1000, text: "It left" },
      { startMs: 1000, endMs: 1500, text: "after sunrise." },
    ];
    expect(cueSentence(cues, 1, 3, 4)).toEqual({
      text: "The boat waited. It left after sunrise.",
      html: "The boat waited. It <b>left</b> after sunrise.",
    });
    expect(cueSentence(cues, 0, 4, 4)).toEqual({
      text: "The boat waited.",
      html: "The <b>boat</b> waited.",
    });
  });

  it("labels a cue with its title and time, including the URL only when enabled", () => {
    expect(
      youtubeSourceLabel(
        "https://www.youtube.com/watch?v=fixture1",
        "A local video - YouTube",
        65000,
        false,
      ),
    ).toEqual({ site: "youtube.com", title: "A local video · 01:05" });
    expect(
      youtubeSourceLabel(
        "https://www.youtube.com/watch?v=fixture1",
        "A local video - YouTube",
        65000,
        true,
      ),
    ).toEqual({
      site: "https://www.youtube.com/watch?v=fixture1&t=65s",
      title: "A local video · 01:05",
    });
  });
});
