export type HoverAction = "pause" | "play";

export type HoverPauseState = {
  video: HTMLVideoElement | null;
  insideZones: ReadonlySet<string>;
  pausedByVoka: boolean;
  userActed: boolean;
  ownAction: HoverAction | null;
  ownActionId: number;
  leavePending: boolean;
  leaveId: number;
};

export type HoverPauseEvent =
  | { type: "enter"; zone: string; videoPlaying: boolean }
  | { type: "leave"; zone: string }
  | { type: "play" | "pause" | "seeking" }
  | { type: "video-switch"; video: HTMLVideoElement | null }
  | { type: "own-action-timeout"; actionId: number }
  | {
      type: "leave-timeout";
      leaveId: number;
      autoResume: boolean;
      videoStillSame: boolean;
    };

export type HoverPauseEffect =
  | { type: HoverAction; video: HTMLVideoElement; actionId: number }
  | { type: "schedule-leave"; leaveId: number };

export function initialHoverPauseState(
  video: HTMLVideoElement | null = null,
): HoverPauseState {
  return {
    video,
    insideZones: new Set(),
    pausedByVoka: false,
    userActed: false,
    ownAction: null,
    ownActionId: 0,
    leavePending: false,
    leaveId: 0,
  };
}

/** Pure state transitions for YouTube hover pause and safe playback recovery. */
export function hoverReducer(
  state: HoverPauseState,
  event: HoverPauseEvent,
): { state: HoverPauseState; effects: HoverPauseEffect[] } {
  switch (event.type) {
    case "video-switch":
      return event.video === state.video
        ? { state, effects: [] }
        : { state: initialHoverPauseState(event.video), effects: [] };
    case "enter": {
      if (state.insideZones.has(event.zone)) return { state, effects: [] };
      const wasLeaving = state.leavePending;
      const firstZone = state.insideZones.size === 0 && !wasLeaving;
      const insideZones = new Set(state.insideZones);
      insideZones.add(event.zone);
      const next = {
        ...state,
        insideZones,
        leavePending: false,
        leaveId: state.leaveId + 1,
        userActed: firstZone ? false : state.userActed,
      };
      if (
        !firstZone ||
        !event.videoPlaying ||
        !state.video ||
        state.pausedByVoka
      )
        return { state: next, effects: [] };
      const actionId = state.ownActionId + 1;
      return {
        state: {
          ...next,
          pausedByVoka: true,
          ownAction: "pause",
          ownActionId: actionId,
        },
        effects: [{ type: "pause", video: state.video, actionId }],
      };
    }
    case "leave": {
      if (!state.insideZones.has(event.zone)) return { state, effects: [] };
      const insideZones = new Set(
        [...state.insideZones].filter((zone) => zone !== event.zone),
      );
      if (insideZones.size > 0)
        return { state: { ...state, insideZones }, effects: [] };
      const leaveId = state.leaveId + 1;
      return {
        state: { ...state, insideZones, leavePending: true, leaveId },
        effects: [{ type: "schedule-leave", leaveId }],
      };
    }
    case "play":
    case "pause":
    case "seeking":
      if (event.type !== "seeking" && state.ownAction === event.type) {
        return {
          state: {
            ...state,
            ownAction: null,
            ownActionId: state.ownActionId + 1,
          },
          effects: [],
        };
      }
      return { state: { ...state, userActed: true }, effects: [] };
    case "own-action-timeout":
      if (state.ownActionId !== event.actionId || !state.ownAction)
        return { state, effects: [] };
      return {
        state: {
          ...state,
          ownAction: null,
          ownActionId: state.ownActionId + 1,
        },
        effects: [],
      };
    case "leave-timeout": {
      if (
        state.leaveId !== event.leaveId ||
        !state.leavePending ||
        state.insideZones.size > 0
      )
        return { state, effects: [] };
      const resume =
        state.pausedByVoka &&
        !state.userActed &&
        event.autoResume &&
        event.videoStillSame &&
        state.video !== null;
      const cleared = {
        ...state,
        pausedByVoka: false,
        userActed: false,
        leavePending: false,
        leaveId: state.leaveId + 1,
      };
      if (!resume) return { state: cleared, effects: [] };
      const actionId = state.ownActionId + 1;
      return {
        state: { ...cleared, ownAction: "play", ownActionId: actionId },
        effects: [{ type: "play", video: state.video!, actionId }],
      };
    }
  }
}

export type HoverPauseOptions = {
  video: () => HTMLVideoElement | null;
  zones: () => Element[];
  autoResume: () => boolean;
};

/** Attaches pointer/media listeners and executes reducer effects. */
export function createHoverPause(options: HoverPauseOptions) {
  let state = initialHoverPauseState();
  let running = false;
  let videoPoll: ReturnType<typeof setInterval> | undefined;
  let leaveTimer: ReturnType<typeof setTimeout> | undefined;
  let leaveTimerId: number | undefined;
  let actionTimer: ReturnType<typeof setTimeout> | undefined;
  let actionTimerId: number | undefined;
  let boundVideo: HTMLVideoElement | null = null;
  const zoneIds = new Map<Element, string>();
  const zoneListeners = new Map<
    Element,
    { enter: EventListener; leave: EventListener }
  >();

  function clearLeaveTimer() {
    if (leaveTimer !== undefined) clearTimeout(leaveTimer);
    leaveTimer = undefined;
    leaveTimerId = undefined;
  }

  function clearActionTimer() {
    if (actionTimer !== undefined) clearTimeout(actionTimer);
    actionTimer = undefined;
    actionTimerId = undefined;
  }

  function syncTimers() {
    if (!state.leavePending) clearLeaveTimer();
    else if (leaveTimerId !== state.leaveId) {
      clearLeaveTimer();
      const leaveId = state.leaveId;
      leaveTimerId = leaveId;
      leaveTimer = setTimeout(() => {
        leaveTimer = undefined;
        leaveTimerId = undefined;
        const currentVideo = syncVideo();
        if (!running) return;
        let autoResume = false;
        try {
          autoResume = options.autoResume();
        } catch {
          /* A settings read failure must never trigger playback. */
        }
        dispatch({
          type: "leave-timeout",
          leaveId,
          autoResume,
          videoStillSame: currentVideo === state.video,
        });
      }, 150);
    }

    if (!state.ownAction) clearActionTimer();
    else if (actionTimerId !== state.ownActionId) {
      clearActionTimer();
      const actionId = state.ownActionId;
      actionTimerId = actionId;
      actionTimer = setTimeout(() => {
        actionTimer = undefined;
        actionTimerId = undefined;
        dispatch({ type: "own-action-timeout", actionId });
      }, 500);
    }
  }

  function runEffects(effects: HoverPauseEffect[]) {
    for (const effect of effects) {
      if (effect.type === "schedule-leave") continue;
      if (!running || effect.video !== options.video()) {
        syncVideo();
        continue;
      }
      try {
        if (effect.type === "pause") effect.video.pause();
        else void effect.video.play().catch(() => {});
      } catch {
        /* Browser autoplay and media state changes can reject these actions. */
      }
    }
  }

  function dispatch(event: HoverPauseEvent) {
    const transition = hoverReducer(state, event);
    state = transition.state;
    syncTimers();
    runEffects(transition.effects);
  }

  function onVideoEvent(event: Event) {
    const eventVideo = event.currentTarget as HTMLVideoElement;
    syncVideo();
    if (eventVideo !== boundVideo) return;
    if (event.type === "play" || event.type === "pause" || event.type === "seeking")
      dispatch({ type: event.type });
  }

  function bindVideo(video: HTMLVideoElement | null) {
    if (boundVideo === video) return;
    if (boundVideo) {
      boundVideo.removeEventListener("play", onVideoEvent);
      boundVideo.removeEventListener("pause", onVideoEvent);
      boundVideo.removeEventListener("seeking", onVideoEvent);
    }
    clearLeaveTimer();
    clearActionTimer();
    boundVideo = video;
    state = hoverReducer(state, { type: "video-switch", video }).state;
    if (boundVideo) {
      boundVideo.addEventListener("play", onVideoEvent);
      boundVideo.addEventListener("pause", onVideoEvent);
      boundVideo.addEventListener("seeking", onVideoEvent);
    }
    syncTimers();
  }

  function syncVideo() {
    const video = options.video();
    if (video !== boundVideo) bindVideo(video);
    return video;
  }

  function start() {
    if (running) return;
    running = true;
    let nextId = 0;
    for (const zone of options.zones()) {
      if (zoneIds.has(zone)) continue;
      const zoneId = `zone-${++nextId}`;
      zoneIds.set(zone, zoneId);
      const enter: EventListener = () => {
        syncVideo();
        const video = boundVideo;
        dispatch({
          type: "enter",
          zone: zoneId,
          videoPlaying: !!video && !video.paused,
        });
      };
      const leave: EventListener = () => dispatch({ type: "leave", zone: zoneId });
      zone.addEventListener("pointerenter", enter);
      zone.addEventListener("pointerleave", leave);
      zoneListeners.set(zone, { enter, leave });
    }
    syncVideo();
    videoPoll = setInterval(syncVideo, 200);
  }

  function reset() {
    clearLeaveTimer();
    clearActionTimer();
    if (!running) {
      state = initialHoverPauseState();
      return;
    }
    const video = options.video();
    if (video !== boundVideo) bindVideo(video);
    state = initialHoverPauseState(video);
  }

  function stop() {
    if (videoPoll !== undefined) clearInterval(videoPoll);
    videoPoll = undefined;
    for (const [zone, listeners] of zoneListeners) {
      zone.removeEventListener("pointerenter", listeners.enter);
      zone.removeEventListener("pointerleave", listeners.leave);
    }
    zoneListeners.clear();
    zoneIds.clear();
    if (boundVideo) {
      boundVideo.removeEventListener("play", onVideoEvent);
      boundVideo.removeEventListener("pause", onVideoEvent);
      boundVideo.removeEventListener("seeking", onVideoEvent);
    }
    boundVideo = null;
    running = false;
    clearLeaveTimer();
    clearActionTimer();
    state = initialHoverPauseState();
  }

  return { start, stop, reset };
}
