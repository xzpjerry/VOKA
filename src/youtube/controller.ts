import type { ReadingSource } from "../reading-session";
import { settings as readSettings } from "../shared";
import {
  chooseEnglishTrack,
  cueAtTime,
  parseJson3,
  type CaptionCue,
  type CaptionTrack,
  type TimedTextCapture,
} from "./captions";
import { createHoverPause } from "./hover-pause";

export type CaptionMethod = 1 | 2 | 3 | 4;
export type CaptionScope = "full-track" | "played-part-only" | "none";

export type AcquisitionResult = {
  method: CaptionMethod;
  scope: CaptionScope;
  cues: CaptionCue[];
  error?: string;
};

export class YouTubeCaptionError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = code;
  }
}

export type CaptionAcquisitionAdapter = {
  enable: (track: CaptionTrack) => Promise<void>;
  waitForTimedText: (
    timeoutMs: number,
    signal?: AbortSignal,
  ) => Promise<TimedTextCapture | undefined>;
  refetch: (
    track: CaptionTrack,
  ) => Promise<{ ok: boolean; status: number; body: string }>;
  readScreen: (
    timeoutMs: number,
    signal?: AbortSignal,
  ) => Promise<CaptionCue[]>;
};

function diagnosticError(error: unknown): string {
  if (error instanceof YouTubeCaptionError) return error.code;
  if (error instanceof DOMException && error.name === "AbortError") return "Aborted";
  if (error instanceof TypeError) return "NetworkError";
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Za-z0-9_-]+$/.test(code)) return code;
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string" && name !== "Error") return name;
  }
  return "Error";
}

/** Implements the timed-text → token refetch → visible caption fallback order. */
export async function acquireCaptions(
  track: CaptionTrack | undefined,
  adapter: CaptionAcquisitionAdapter,
  options: {
    timedTextTimeoutMs?: number;
    screenTimeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<AcquisitionResult> {
  if (!track)
    return {
      method: 4,
      scope: "none",
      cues: [],
      error: "NoEnglishTrack",
    };

  const timedTextTimeoutMs = options.timedTextTimeoutMs ?? 8000;
  const screenTimeoutMs = options.screenTimeoutMs ?? 8000;
  let failure = "TimedTextTimeout";
  let captured: TimedTextCapture | undefined;
  const waiting = adapter.waitForTimedText(timedTextTimeoutMs, options.signal);
  try {
    await adapter.enable(track);
    captured = await waiting;
  } catch (error) {
    if (options.signal?.aborted) throw error;
    failure = diagnosticError(error);
    captured = undefined;
  }

  if (captured) {
    const parsed = parseJson3(captured.body);
    const languageMatches =
      captured.lang?.toLowerCase() === track.languageCode.toLowerCase();
    if (languageMatches && parsed.length) {
      return { method: 1, scope: "full-track", cues: parsed };
    }
    if (!languageMatches || parsed.length === 0) {
      try {
        const result = await adapter.refetch(track);
        if (!result.ok) failure = `HTTP_${result.status}`;
        else {
          const refetched = parseJson3(result.body);
          if (refetched.length)
            return { method: 2, scope: "full-track", cues: refetched };
          failure = "EmptyRefetch";
        }
      } catch (error) {
        if (options.signal?.aborted) throw error;
        failure = diagnosticError(error);
      }
    }
  }

  try {
    const screenCues = await adapter.readScreen(screenTimeoutMs, options.signal);
    if (screenCues.length)
      return {
        method: 3,
        scope: "played-part-only",
        cues: screenCues,
      };
  } catch (error) {
    if (options.signal?.aborted) throw error;
    failure = diagnosticError(error);
  }
  return {
    method: 4,
    scope: "none",
    cues: [],
    error: failure || "NoSubtitles",
  };
}

type MainRequestType = "tracks" | "enable" | "refetch" | "time" | "seek";
type MainRequest = {
  source: "voka-yt-req";
  type: MainRequestType;
  requestId: string;
  languageCode?: string;
  kind?: string;
  timeSeconds?: number;
};
type MainTimedText = TimedTextCapture & {
  source: "voka-yt";
  type: "timedtext";
};
type MainResponse = {
  source: "voka-yt";
  type: "response";
  requestId?: string;
  requestType?: MainRequestType;
  error?: string;
  [key: string]: unknown;
};

type PendingRequest = {
  resolve: (value: MainResponse) => void;
  reject: (reason: unknown) => void;
  timer: number;
};

export type YouTubeCaptionAdapter = CaptionAcquisitionAdapter & {
  inject: () => Promise<void>;
  tracks: () => Promise<{ tracks: CaptionTrack[]; videoId?: string }>;
  getCurrentTime: () => Promise<number>;
  seekTo?: (timeSeconds: number) => Promise<void>;
  readCaptionText: () => string;
  clearTimedTextWaiters: () => void;
  dispose: () => void;
};

function createPageCaptionAdapter(doc: Document): YouTubeCaptionAdapter {
  const pageWindow = doc.defaultView;
  if (!pageWindow) throw new YouTubeCaptionError("NoPageWindow");
  const win = pageWindow;
  const pending = new Map<string, PendingRequest>();
  const timedTextWaiters = new Set<(value: TimedTextCapture) => void>();

  function clearPending() {
    for (const request of pending.values()) win.clearTimeout(request.timer);
    pending.clear();
    timedTextWaiters.clear();
  }

  const onMessage = (event: MessageEvent<unknown>) => {
    if (event.source !== win || !event.data || typeof event.data !== "object")
      return;
    const data = event.data as Partial<MainTimedText> | Partial<MainResponse>;
    if (data.source !== "voka-yt") return;
    if (data.type === "timedtext") {
      const capture = data as MainTimedText;
      for (const waiter of [...timedTextWaiters]) waiter(capture);
      return;
    }
    if (data.type !== "response" || typeof data.requestId !== "string") return;
    const request = pending.get(data.requestId);
    if (!request) return;
    pending.delete(data.requestId);
    win.clearTimeout(request.timer);
    if (typeof data.error === "string")
      request.reject(new YouTubeCaptionError(data.error));
    else request.resolve(data as MainResponse);
  };
  win.addEventListener("message", onMessage as EventListener);

  function request(type: MainRequestType, values: Partial<MainRequest> = {}) {
    const requestId = `voka-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const message: MainRequest = {
      source: "voka-yt-req",
      type,
      requestId,
      ...values,
    };
    return new Promise<MainResponse>((resolve, reject) => {
      const timer = win.setTimeout(() => {
        pending.delete(requestId);
        reject(new YouTubeCaptionError("MainWorldTimeout"));
      }, 10000);
      pending.set(requestId, { resolve, reject, timer });
      win.postMessage(message, win.location.origin);
    });
  }

  return {
    async inject() {
      const response = await chrome.runtime.sendMessage({
        type: "youtube-main-inject",
      });
      if (response?.error)
        throw new YouTubeCaptionError("MainWorldInjectionFailed");
    },
    async tracks() {
      const response = await request("tracks");
      const tracks = Array.isArray(response.tracks)
        ? (response.tracks as CaptionTrack[])
        : [];
      return {
        tracks,
        ...(typeof response.videoId === "string"
          ? { videoId: response.videoId }
          : {}),
      };
    },
    async enable(track) {
      await request("enable", {
        languageCode: track.languageCode,
        ...(track.kind ? { kind: track.kind } : {}),
      });
    },
    waitForTimedText(timeoutMs, signal) {
      return new Promise((resolve) => {
        let finished = false;
        const finish = (value?: TimedTextCapture) => {
          if (finished) return;
          finished = true;
          win.clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          timedTextWaiters.delete(waiter);
          resolve(value);
        };
        const waiter = (value: TimedTextCapture) => finish(value);
        const onAbort = () => finish(undefined);
        const timer = win.setTimeout(() => finish(undefined), timeoutMs);
        timedTextWaiters.add(waiter);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) finish(undefined);
      });
    },
    async refetch(track) {
      const response = await request("refetch", {
        languageCode: track.languageCode,
        ...(track.kind ? { kind: track.kind } : {}),
      });
      return {
        ok: response.ok === true,
        status: typeof response.status === "number" ? response.status : 0,
        body: typeof response.body === "string" ? response.body : "",
      };
    },
    async readScreen(timeoutMs, signal) {
      const deadline = Date.now() + timeoutMs;
      const video = () => doc.querySelector("video");
      const readText = () => {
        const container = doc.querySelector(".ytp-caption-window-container");
        if (!container) return "";
        return Array.from(container.querySelectorAll(".ytp-caption-segment"))
          .map((segment) => segment.textContent ?? "")
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
      };
      while (Date.now() <= deadline && !signal?.aborted) {
        const text = readText();
        if (text) {
          const currentTime = (await this.getCurrentTime()) * 1000;
          return [
            {
              startMs: Math.max(0, Math.round(currentTime)),
              endMs: Math.max(0, Math.round(currentTime)) + 1,
              text,
            },
          ];
        }
        if (!video() && timeoutMs === 0) return [];
        await new Promise<void>((resolve) => win.setTimeout(resolve, 200));
      }
      return [];
    },
    async getCurrentTime() {
      try {
        const response = await request("time");
        if (typeof response.currentTime === "number" && Number.isFinite(response.currentTime))
          return response.currentTime;
      } catch {
        /* The local video value is a safe fallback if the page hook is changing. */
      }
      return doc.querySelector("video")?.currentTime ?? 0;
    },
    async seekTo(timeSeconds) {
      await request("seek", { timeSeconds });
    },
    readCaptionText() {
      const container = doc.querySelector(".ytp-caption-window-container");
      if (!container) return "";
      return Array.from(container.querySelectorAll(".ytp-caption-segment"))
        .map((segment) => segment.textContent ?? "")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
    },
    clearTimedTextWaiters() {
      timedTextWaiters.clear();
    },
    dispose() {
      clearPending();
      win.removeEventListener("message", onMessage as EventListener);
    },
  };
}

type SessionHandle = {
  start: () => Promise<void>;
  isRunning: () => boolean;
  addSource: (source: ReadingSource) => void;
  removeSource: (source: ReadingSource) => void;
  getHoverZones?: () => Element[];
  destroy: () => void;
};

type ControllerOptions = {
  uiDocument: Document;
  createSession: () => SessionHandle;
  adapter?: YouTubeCaptionAdapter;
  readHref?: () => string;
  diagnosticsEnabled?: () => Promise<boolean>;
  autoResumeEnabled?: () => Promise<boolean>;
  pollMs?: number;
  timedTextTimeoutMs?: number;
  screenTimeoutMs?: number;
};

type SubtitleLine = {
  root: HTMLDivElement;
  text: HTMLSpanElement;
  close: HTMLButtonElement;
  diagnostic: HTMLDivElement;
};

function youtubeWatchOrShorts(url: string) {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === "www.youtube.com" &&
      (parsed.pathname === "/watch" || parsed.pathname.startsWith("/shorts/"))
    );
  } catch {
    return false;
  }
}

function formatText(key: string, fallback: string, values: string[] = []) {
  if (typeof chrome !== "undefined" && chrome.i18n) {
    const translated = chrome.i18n.getMessage(key, values);
    if (translated) return translated;
  }
  return values.reduce(
    (result, value, index) => result.replaceAll(`$${index + 1}`, value),
    fallback,
  );
}

class ScreenCueRecorder {
  private text = "";
  private current: CaptionCue | undefined;
  private cues: CaptionCue[] = [];

  constructor(
    private readonly adapter: YouTubeCaptionAdapter,
    private readonly doc: Document,
  ) {}

  getCues() {
    return this.cues.map((cue) => ({ ...cue }));
  }

  async sample(timeMs: number) {
    const text = this.adapter.readCaptionText();
    if (text === this.text) {
      if (this.current)
        this.current.endMs = Math.max(this.current.startMs + 1, timeMs + 200);
      return false;
    }
    if (this.current)
      this.current.endMs = Math.max(this.current.startMs + 1, timeMs);
    this.text = text;
    this.current = undefined;
    if (text) {
      this.current = {
        startMs: Math.max(0, timeMs),
        endMs: Math.max(1, timeMs + 200),
        text,
      };
      this.cues.push(this.current);
    }
    return true;
  }

  async wait(timeoutMs: number, signal?: AbortSignal) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline && !signal?.aborted) {
      const timeMs = (await this.adapter.getCurrentTime()) * 1000;
      await this.sample(timeMs);
      if (this.cues.length) return this.getCues();
      await new Promise<void>((resolve) =>
        this.doc.defaultView?.setTimeout(resolve, 200),
      );
    }
    return [];
  }

}

/** Owns YouTube's current video session and its light-DOM subtitle source. */
export function createYouTubeController(options: ControllerOptions) {
  const { uiDocument } = options;
  const pageWindow = uiDocument.defaultView;
  if (!pageWindow) throw new Error("YouTube controller needs a page window");
  const win = pageWindow;
  const adapter = options.adapter ?? createPageCaptionAdapter(uiDocument);
  const readHref = options.readHref ?? (() => win.location.href);
  const getDiagnostics =
    options.diagnosticsEnabled ??
    (async () => {
      const value = await chrome.storage.local.get({ youtubeDiagnostics: false });
      return value.youtubeDiagnostics === true;
    });
  const getAutoResume =
    options.autoResumeEnabled ??
    (async () => (await readSettings()).youtubeAutoResume);
  const events = new win.EventTarget();
  const pollMs = options.pollMs ?? 500;
  const timedTextTimeoutMs = options.timedTextTimeoutMs ?? 8000;
  const screenTimeoutMs = options.screenTimeoutMs ?? 8000;

  let started = false;
  let disposed = false;
  let paused = false;
  let activeHref = "";
  let generation = 0;
  let routeTimer: number | undefined;
  let displayTimer: number | undefined;
  let activeVideo: HTMLVideoElement | null = null;
  let activeSession: SessionHandle | undefined;
  let abortController: AbortController | undefined;
  let line: SubtitleLine | undefined;
  let nativeCaptionStyle: HTMLStyleElement | undefined;
  let source: ReadingSource | undefined;
  let cues: CaptionCue[] = [];
  let method: CaptionMethod | undefined;
  let scope: CaptionScope = "none";
  let error: string | undefined;
  let videoId: string | undefined;
  let diagnosticsEnabled = false;
  let youtubeAutoResume = true;
  let closedByUser = false;
  let activeCueSignature = "";
  let screenRecorder: ScreenCueRecorder | undefined;
  let displayBusy = false;
  let hoverPause: ReturnType<typeof createHoverPause> | undefined;

  function dispatchCuesChanged() {
    const CustomEventConstructor = win.CustomEvent;
    events.dispatchEvent(
      new CustomEventConstructor("cues-changed", {
        detail: {
          cues: cues.map((cue) => ({ ...cue })),
          method: method ?? null,
          scope,
        },
      }),
    );
  }

  function setCues(next: CaptionCue[], nextMethod: CaptionMethod, nextScope: CaptionScope, nextError?: string) {
    cues = next.map((cue) => ({ ...cue }));
    method = nextMethod;
    scope = nextScope;
    error = nextError;
    activeCueSignature = "";
    dispatchCuesChanged();
    updateDiagnostic();
  }

  function updateDiagnostic() {
    if (!line) return;
    line.diagnostic.hidden = !diagnosticsEnabled;
    if (diagnosticsEnabled) {
      const status = error ?? formatText("youtubeDiagnosticOk", "OK");
      line.diagnostic.textContent = formatText(
        "youtubeDiagnosticLine",
        "方法 $1 · $2 条 · $3",
        [String(method ?? 4), String(cues.length), status],
      );
    }
  }

  function removeNativeCaptionStyle() {
    nativeCaptionStyle?.remove();
    nativeCaptionStyle = undefined;
  }

  function hideNativeCaptions() {
    if (nativeCaptionStyle?.isConnected) return;
    nativeCaptionStyle = uiDocument.createElement("style");
    nativeCaptionStyle.id = "voka-youtube-caption-style";
    nativeCaptionStyle.textContent =
      "#movie_player .ytp-caption-window-container{opacity:0!important}";
    (uiDocument.head ?? uiDocument.documentElement).append(nativeCaptionStyle);
  }

  function removeLine() {
    if (source && activeSession) activeSession.removeSource(source);
    source = undefined;
    line?.root.remove();
    line = undefined;
    removeNativeCaptionStyle();
    activeCueSignature = "";
  }

  function stopHoverPause() {
    const controller = hoverPause;
    hoverPause = undefined;
    controller?.reset();
    controller?.stop();
  }

  function startHoverPause(subtitleRoot: HTMLElement) {
    if (hoverPause) return;
    hoverPause = createHoverPause({
      video: () => uiDocument.querySelector("video"),
      zones: () => [
        subtitleRoot,
        ...(activeSession?.getHoverZones?.() ?? []),
      ],
      autoResume: () => youtubeAutoResume,
    });
    hoverPause.start();
  }

  function stopDisplayLoop() {
    if (displayTimer !== undefined) win.clearInterval(displayTimer);
    displayTimer = undefined;
    activeVideo?.removeEventListener("timeupdate", onTimeUpdate);
    activeVideo = null;
  }

  function closeLine() {
    closedByUser = true;
    stopDisplayLoop();
    stopHoverPause();
    removeLine();
  }

  function createLine(player: HTMLElement, pauseOnHover = true) {
    if (line?.root.isConnected) {
      if (pauseOnHover) startHoverPause(line.root);
      return line;
    }
    const root = uiDocument.createElement("div");
    root.id = "voka-subtitle";
    root.setAttribute("role", "status");
    root.style.cssText =
      "all:initial;position:absolute;left:50%;bottom:60px;transform:translateX(-50%);z-index:2147483646;box-sizing:border-box;max-width:80%;padding:8px 30px 8px 12px;border-radius:6px;background:rgba(0,0,0,.72);color:#fff;text-align:center;font:20px/1.4 system-ui,sans-serif;white-space:pre-wrap;overflow-wrap:anywhere;pointer-events:auto";
    const text = uiDocument.createElement("span");
    text.className = "voka-subtitle-text";
    const close = uiDocument.createElement("button");
    close.type = "button";
    close.textContent = "×";
    close.setAttribute(
      "aria-label",
      formatText("youtubeSubtitleClose", "Close VOKA subtitles"),
    );
    close.style.cssText =
      "all:initial;position:absolute;right:5px;top:3px;color:#fff;cursor:pointer;font:20px/1 system-ui,sans-serif";
    close.addEventListener("click", closeLine);
    const diagnostic = uiDocument.createElement("div");
    diagnostic.className = "voka-youtube-diagnostic";
    diagnostic.style.cssText =
      "margin-top:3px;color:#ccc;font:11px/1.3 system-ui,sans-serif;text-align:center";
    root.append(text, close, diagnostic);
    player.append(root);
    line = { root, text, close, diagnostic };
    if (pauseOnHover) startHoverPause(root);
    updateDiagnostic();
    return line;
  }

  function updateLineText(timeMs: number) {
    if (!line || closedByUser) return;
    const cue = cueAtTime(cues, timeMs);
    const signature = cue ? `${cue.startMs}\u0000${cue.endMs}\u0000${cue.text}` : "";
    if (signature === activeCueSignature) return;
    activeCueSignature = signature;
    if (!cue) {
      line.root.hidden = true;
      delete line.root.dataset.startMs;
      line.text.textContent = "";
      removeNativeCaptionStyle();
      return;
    }
    line.root.hidden = false;
    line.root.dataset.startMs = String(cue.startMs);
    if (line.text.textContent !== cue.text) line.text.textContent = cue.text;
    hideNativeCaptions();
  }

  function showNoSubtitles(player: HTMLElement, methodNumber: CaptionMethod, failure?: string) {
    const subtitle = createLine(player, false);
    subtitle.root.hidden = false;
    subtitle.text.textContent = formatText(
      "youtubeNoSubtitles",
      "No readable English subtitles for this video",
    );
    removeNativeCaptionStyle();
    updateDiagnostic();
    if (method !== methodNumber || error !== failure) {
      method = methodNumber;
      scope = "none";
      error = failure;
      cues = [];
      dispatchCuesChanged();
      updateDiagnostic();
    }
  }

  function onTimeUpdate() {
    void updateDisplay();
  }

  async function updateDisplay() {
    if (!line || closedByUser || displayBusy) return;
    displayBusy = true;
    try {
      const currentVideo = uiDocument.querySelector("video");
      if (activeVideo !== currentVideo) {
        activeVideo?.removeEventListener("timeupdate", onTimeUpdate);
        activeVideo = currentVideo;
        activeVideo?.addEventListener("timeupdate", onTimeUpdate);
      }
      const timeMs = Math.max(0, (await adapter.getCurrentTime()) * 1000);
      if (method === 3 && screenRecorder) {
        const changed = await screenRecorder.sample(timeMs);
        if (changed) {
          cues = screenRecorder.getCues();
          dispatchCuesChanged();
          updateDiagnostic();
        } else {
          cues = screenRecorder.getCues();
          updateDiagnostic();
        }
      }
      updateLineText(timeMs);
    } catch {
      /* A transient page-player change is handled on the next 200 ms tick. */
    } finally {
      displayBusy = false;
    }
  }

  function startDisplayLoop() {
    stopDisplayLoop();
    if (!line || closedByUser) return;
    displayTimer = win.setInterval(() => void updateDisplay(), 200);
    void updateDisplay();
  }

  function makeScreenReader(recorder: ScreenCueRecorder): CaptionAcquisitionAdapter["readScreen"] {
    return (timeoutMs, signal) => recorder.wait(timeoutMs, signal);
  }

  async function currentTracks(signal: AbortSignal) {
    for (let attempt = 0; attempt < 40; attempt++) {
      if (signal.aborted) throw new YouTubeCaptionError("Aborted");
      try {
        return await adapter.tracks();
      } catch (failure) {
        if (!(failure instanceof YouTubeCaptionError) || failure.code !== "NoPlayer")
          throw failure;
        await new Promise<void>((resolve) => win.setTimeout(resolve, 200));
      }
    }
    throw new YouTubeCaptionError("NoPlayer");
  }

  async function startCurrentVideo(href: string) {
    const epoch = ++generation;
    const abort = new AbortController();
    abortController = abort;
    closedByUser = false;
    const session = options.createSession();
    activeSession = session;
    try {
      await session.start();
      if (epoch !== generation || abort.signal.aborted) return;
      if (!session.isRunning()) {
        session.destroy();
        if (activeSession === session) activeSession = undefined;
        return;
      }
      await adapter.inject();
      if (epoch !== generation || abort.signal.aborted) return;
      const current = await currentTracks(abort.signal);
      if (epoch !== generation || abort.signal.aborted) return;
      videoId = current.videoId;
      const track = chooseEnglishTrack(current.tracks);
      const player = uiDocument.getElementById("movie_player");
      if (!player) throw new YouTubeCaptionError("NoPlayer");
      if (!track) {
        setCues([], 4, "none", "NoEnglishTrack");
        showNoSubtitles(player, 4, "NoEnglishTrack");
        return;
      }

      const recorder = new ScreenCueRecorder(adapter, uiDocument);
      screenRecorder = recorder;
      const acquisition = await acquireCaptions(
        track,
        {
          enable: (selected) => adapter.enable(selected),
          waitForTimedText: (timeout, signal) =>
            adapter.waitForTimedText(timeout, signal),
          refetch: (selected) => adapter.refetch(selected),
          readScreen: makeScreenReader(recorder),
        },
        {
          timedTextTimeoutMs,
          screenTimeoutMs,
          signal: abort.signal,
        },
      );
      if (epoch !== generation || abort.signal.aborted || readHref() !== href)
        return;
      setCues(acquisition.cues, acquisition.method, acquisition.scope, acquisition.error);
      if (acquisition.method === 4 || !acquisition.cues.length) {
        showNoSubtitles(player, acquisition.method, acquisition.error ?? "NoSubtitles");
        return;
      }
      const subtitle = createLine(player);
      source = { kind: "dom", root: subtitle.root, listed: false };
      activeSession.addSource(source);
      if (acquisition.method !== 3) screenRecorder = undefined;
      startDisplayLoop();
    } catch (failure) {
      if (epoch !== generation || abort.signal.aborted) return;
      const player = uiDocument.getElementById("movie_player");
      if (player) {
        const code = diagnosticError(failure);
        setCues([], 4, "none", code);
        showNoSubtitles(player, 4, code);
      }
    }
  }

  function clearCurrentVideo(destroySession: boolean) {
    ++generation;
    abortController?.abort();
    abortController = undefined;
    adapter.clearTimedTextWaiters();
    stopDisplayLoop();
    stopHoverPause();
    removeLine();
    screenRecorder = undefined;
    cues = [];
    method = undefined;
    scope = "none";
    error = undefined;
    videoId = undefined;
    activeCueSignature = "";
    dispatchCuesChanged();
    if (destroySession) {
      const session = activeSession;
      activeSession = undefined;
      session?.destroy();
    }
  }

  function stopCurrentVideo() {
    clearCurrentVideo(true);
  }

  async function refreshLocation() {
    if (disposed) return;
    const href = readHref();
    if (href === activeHref) return;
    activeHref = href;
    stopCurrentVideo();
    if (!paused && youtubeWatchOrShorts(href)) await startCurrentVideo(href);
  }

  function onNavigation() {
    void refreshLocation();
  }

  function onRefresh() {
    if (paused || disposed || !youtubeWatchOrShorts(readHref())) return;
    activeHref = "";
    void refreshLocation();
  }

  function onRuntimeMessage(message: { type?: string } | undefined) {
    if (message?.type === "pause-reading") {
      paused = true;
      clearCurrentVideo(false);
    } else if (message?.type === "connection-lost") {
      clearCurrentVideo(false);
    }
  }

  const onStorageChanged = (
    changes: { [key: string]: chrome.storage.StorageChange },
    area: string,
  ) => {
    if (area !== "local") return;
    if (changes.youtubeDiagnostics) {
      diagnosticsEnabled = changes.youtubeDiagnostics.newValue === true;
      updateDiagnostic();
    }
    if (changes.youtubeAutoResume)
      youtubeAutoResume = changes.youtubeAutoResume.newValue !== false;
  };

  async function start() {
    if (started) return;
    started = true;
    win.addEventListener("yt-navigate-finish", onNavigation);
    uiDocument.addEventListener("yt-navigate-finish", onNavigation);
    uiDocument.addEventListener("voka-refresh", onRefresh);
    routeTimer = win.setInterval(onNavigation, pollMs);
    if (typeof chrome !== "undefined" && chrome.storage?.onChanged)
      chrome.storage.onChanged.addListener(onStorageChanged);
    if (typeof chrome !== "undefined" && chrome.runtime?.onMessage)
      chrome.runtime.onMessage.addListener(onRuntimeMessage);
    try {
      diagnosticsEnabled = await getDiagnostics();
    } catch {
      diagnosticsEnabled = false;
    }
    try {
      youtubeAutoResume = await getAutoResume();
    } catch {
      youtubeAutoResume = true;
    }
    await refreshLocation();
  }

  function stop() {
    if (disposed) return;
    disposed = true;
    if (routeTimer !== undefined) win.clearInterval(routeTimer);
    routeTimer = undefined;
    win.removeEventListener("yt-navigate-finish", onNavigation);
    uiDocument.removeEventListener("yt-navigate-finish", onNavigation);
    uiDocument.removeEventListener("voka-refresh", onRefresh);
    if (typeof chrome !== "undefined" && chrome.storage?.onChanged)
      chrome.storage.onChanged.removeListener(onStorageChanged);
    if (typeof chrome !== "undefined" && chrome.runtime?.onMessage)
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    stopCurrentVideo();
    adapter.dispose();
  }

  return {
    start,
    stop,
    close: closeLine,
    refreshLocation,
    getCues: () => cues.map((cue) => ({ ...cue })),
    getMethod: () => method,
    getScope: () => scope,
    seekTo(timeSeconds: number) {
      if (!Number.isFinite(timeSeconds) || timeSeconds < 0) return;
      if (adapter.seekTo) {
        void adapter.seekTo(timeSeconds).catch(() => {});
        return;
      }
      const video = uiDocument.querySelector("video");
      if (video) video.currentTime = timeSeconds;
    },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
  };
}
