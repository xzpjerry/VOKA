// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  hoverReducer,
  initialHoverPauseState,
  type HoverPauseEvent,
  type HoverPauseState,
} from "./hover-pause";

function harness(video = document.createElement("video")) {
  let state = initialHoverPauseState(video);
  const send = (event: HoverPauseEvent) => {
    const result = hoverReducer(state, event);
    state = result.state;
    return result.effects;
  };
  const enterAndAcknowledgePause = (zone = "subtitle") => {
    const effects = send({ type: "enter", zone, videoPlaying: true });
    if (effects.some((effect) => effect.type === "pause"))
      send({ type: "pause" });
    return effects;
  };
  const leaveAndTimeout = (autoResume = true, videoStillSame = true) => {
    send({ type: "leave", zone: "subtitle" });
    const effects = send({
      type: "leave-timeout",
      leaveId: state.leaveId,
      autoResume,
      videoStillSame,
    });
    return effects;
  };
  return {
    send,
    enterAndAcknowledgePause,
    leaveAndTimeout,
    get state(): HoverPauseState {
      return state;
    },
  };
}

describe("YouTube hover pause reducer", () => {
  it("pauses on entry and resumes after leaving when no user action intervenes", () => {
    const h = harness();
    expect(h.enterAndAcknowledgePause().map((effect) => effect.type)).toEqual([
      "pause",
    ]);
    expect(h.leaveAndTimeout().map((effect) => effect.type)).toEqual(["play"]);
  });

  it("does not resume after the user pauses during the hover", () => {
    const h = harness();
    h.enterAndAcknowledgePause();
    h.send({ type: "pause" });
    expect(h.state.userActed).toBe(true);
    expect(h.leaveAndTimeout()).toEqual([]);
  });

  it("does not resume after the user seeks during the hover", () => {
    const h = harness();
    h.enterAndAcknowledgePause();
    h.send({ type: "seeking" });
    expect(h.state.userActed).toBe(true);
    expect(h.leaveAndTimeout()).toEqual([]);
  });

  it("does not pause or resume a video that was already paused on entry", () => {
    const h = harness();
    expect(
      h.send({ type: "enter", zone: "subtitle", videoPlaying: false }),
    ).toEqual([]);
    expect(h.state.pausedByVoka).toBe(false);
    expect(h.leaveAndTimeout()).toEqual([]);
  });

  it("treats a quick move from the subtitle line to the card as one hover", () => {
    const h = harness();
    h.enterAndAcknowledgePause("subtitle");
    h.send({ type: "leave", zone: "subtitle" });
    const staleLeaveId = h.state.leaveId;
    expect(
      h.send({
        type: "enter",
        zone: "card",
        videoPlaying: false,
      }),
    ).toEqual([]);
    expect(
      h.send({
        type: "leave-timeout",
        leaveId: staleLeaveId,
        autoResume: true,
        videoStillSame: true,
      }),
    ).toEqual([]);
    expect(h.state.pausedByVoka).toBe(true);
    h.send({ type: "leave", zone: "card" });
    expect(
      h.send({
        type: "leave-timeout",
        leaveId: h.state.leaveId,
        autoResume: true,
        videoStillSame: true,
      }).map((effect) => effect.type),
    ).toEqual(["play"]);
  });

  it("does not resume when automatic playback recovery is disabled", () => {
    const h = harness();
    h.enterAndAcknowledgePause();
    expect(h.leaveAndTimeout(false)).toEqual([]);
  });

  it("resets on a video switch and never resumes the previous video", () => {
    const h = harness();
    const oldVideo = h.state.video;
    h.enterAndAcknowledgePause();
    const nextVideo = document.createElement("video");
    expect(
      h.send({ type: "video-switch", video: nextVideo }),
    ).toEqual([]);
    expect(h.state.video).toBe(nextVideo);
    expect(h.state.pausedByVoka).toBe(false);
    expect(h.state.insideZones.size).toBe(0);
    expect(oldVideo).not.toBe(nextVideo);
    expect(
      h.send({
        type: "leave-timeout",
        leaveId: h.state.leaveId,
        autoResume: true,
        videoStillSame: false,
      }),
    ).toEqual([]);
  });

  it("attributes only matching VOKA actions and expires the flag after 500 ms", () => {
    const h = harness();
    h.send({ type: "enter", zone: "subtitle", videoPlaying: true });
    const actionId = h.state.ownActionId;
    expect(h.state.ownAction).toBe("pause");
    h.send({ type: "own-action-timeout", actionId });
    expect(h.state.ownAction).toBe(null);
    h.send({ type: "pause" });
    expect(h.state.userActed).toBe(true);
  });

  it("treats external play events as user actions", () => {
    const h = harness();
    h.enterAndAcknowledgePause();
    h.send({ type: "play" });
    expect(h.state.userActed).toBe(true);
    expect(h.leaveAndTimeout()).toEqual([]);
  });
});
