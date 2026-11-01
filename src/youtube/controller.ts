import type { ReadingSource } from "../reading-session";
import { settings as readSettings } from "../shared";
import {
  chooseEnglishTrack,
  cueAtTime,
  hasPlayerToken,
  parseJson3,
  type CaptionCue,
  type CaptionTrack,
  type TokenSource,
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
  tokenSource: TokenSource;
  httpStatus?: number;
  responseBytes?: number;
};

export type CaptionAcquisitionState = { forcedRefreshUsed: boolean };

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
    onAdStateChange?: (showing: boolean) => void,
  ) => Promise<TimedTextCapture | undefined>;
  refetch: (
    track: CaptionTrack,
  ) => Promise<{
    ok: boolean;
    status: number;
    body: string;
    tokenSource?: TokenSource;
    responseBytes?: number;
  }>;
  readScreen: (
    timeoutMs: number,
    signal?: AbortSignal,
  ) => Promise<CaptionCue[]>;
  isAdShowing?: () => boolean;
  waitForAdEnd?: (
    signal?: AbortSignal,
    onWaiting?: (waiting: boolean) => void,
  ) => Promise<void>;
  getTokenSource?: () => Promise<TokenSource>;
  disableCaptions?: () => Promise<void>;
  reloadCaptions?: (track: CaptionTrack) => Promise<void>;
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

function bodyBytes(body: string) {
  return new TextEncoder().encode(body).byteLength;
}

function aborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new YouTubeCaptionError("Aborted");
}

function delay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new YouTubeCaptionError("Aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new YouTubeCaptionError("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Implements ad-aware timed-text → token refetch → forced refresh → screen fallback. */
export async function acquireCaptions(
  track: CaptionTrack | undefined,
  adapter: CaptionAcquisitionAdapter,
  options: {
    timedTextTimeoutMs?: number;
    screenTimeoutMs?: number;
    signal?: AbortSignal;
    initialTokenSource?: TokenSource;
    state?: CaptionAcquisitionState;
    onAdWaiting?: (waiting: boolean) => void;
    forceRefreshDelayMs?: number;
    forceRefreshFirstWaitMs?: number;
    forceRefreshTotalWaitMs?: number;
  } = {},
): Promise<AcquisitionResult> {
  const state = options.state ?? { forcedRefreshUsed: false };
  const signal = options.signal;
  let tokenSource: TokenSource = options.initialTokenSource ?? "none";
  let httpStatus: number | undefined;
  let responseBytes: number | undefined;
  const result = (
    method: CaptionMethod,
    cues: CaptionCue[],
    error?: string,
  ): AcquisitionResult => ({
    method,
    scope: method === 1 || method === 2
      ? "full-track"
      : method === 3
        ? "played-part-only"
        : "none",
    cues,
    ...(error ? { error } : {}),
    tokenSource,
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(responseBytes === undefined ? {} : { responseBytes }),
  });

  if (!track)
    return result(4, [], "NoEnglishTrack");

  const timedTextTimeoutMs = options.timedTextTimeoutMs ?? 8000;
  const screenTimeoutMs = options.screenTimeoutMs ?? 8000;
  const waitForAdEnd = async () => {
    if (adapter.waitForAdEnd) {
      await adapter.waitForAdEnd(signal, options.onAdWaiting);
      return;
    }
    options.onAdWaiting?.(!!adapter.isAdShowing?.());
    aborted(signal);
  };
  const getTokenSource = async (): Promise<TokenSource> => {
    try {
      return await adapter.getTokenSource?.() ?? tokenSource;
    } catch {
      return tokenSource;
    }
  };
  const waitAndEnable = async (timeoutMs: number) => {
    await waitForAdEnd();
    tokenSource = await getTokenSource();
    const waiting = adapter.waitForTimedText(
      timeoutMs,
      signal,
      options.onAdWaiting,
    );
    try {
      await adapter.enable(track);
    } catch (error) {
      if (signal?.aborted) throw error;
      return { capture: undefined, failure: diagnosticError(error) };
    }
    return { capture: await waiting, failure: undefined };
  };

  let failure = "TimedTextTimeout";
  let captured: TimedTextCapture | undefined;
  try {
    const first = await waitAndEnable(timedTextTimeoutMs);
    captured = first.capture;
    if (first.failure) failure = first.failure;
  } catch (error) {
    if (signal?.aborted) throw error;
    failure = diagnosticError(error);
    captured = undefined;
  }

  const tryCapturedOrRefetch = async (capture: TimedTextCapture | undefined) => {
    if (capture) {
      httpStatus = capture.status;
      responseBytes = capture.responseBytes ?? bodyBytes(capture.body);
      if (hasPlayerToken(capture.url)) tokenSource = "hook";
    }
    const parsed = capture ? parseJson3(capture.body) : [];
    if (capture) {
      const languageMatches =
        capture.lang?.toLowerCase() === track.languageCode.toLowerCase();
      if (languageMatches && parsed.length) return result(1, parsed);
    }
    await waitForAdEnd();
    const sourceBeforeRefetch = await getTokenSource();
    if (sourceBeforeRefetch !== "none") tokenSource = sourceBeforeRefetch;
    if (tokenSource !== "none") {
      try {
        const refetched = await adapter.refetch(track);
        tokenSource = refetched.tokenSource ?? tokenSource;
        httpStatus = refetched.status;
        responseBytes = refetched.responseBytes ?? bodyBytes(refetched.body);
        if (!refetched.ok) failure = `HTTP_${refetched.status}`;
        else {
          const cues = parseJson3(refetched.body);
          if (cues.length) return result(2, cues);
          failure = "EmptyRefetch";
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        failure = diagnosticError(error);
      }
    }
    return undefined;
  };

  const capturedResult = await tryCapturedOrRefetch(captured);
  if (capturedResult) return capturedResult;

  // A request may have been cached before the MAIN-world hook was installed.
  // Resource timing supplies its token; only force the player when neither path
  // found a token and step 1 produced no request at all.
  if (
    !captured &&
    tokenSource === "none" &&
    !state.forcedRefreshUsed &&
    adapter.disableCaptions &&
    adapter.reloadCaptions
  ) {
    state.forcedRefreshUsed = true;
    try {
      await waitForAdEnd();
      await adapter.disableCaptions();
      const offDelay = options.forceRefreshDelayMs ?? 300;
      await delay(offDelay, signal);
      const firstWaitMs = options.forceRefreshFirstWaitMs ?? 5000;
      const firstWaiting = adapter.waitForTimedText(
        firstWaitMs,
        signal,
        options.onAdWaiting,
      );
      await adapter.enable(track);
      captured = await firstWaiting;
      if (!captured) {
        const totalWaitMs = options.forceRefreshTotalWaitMs ?? 8000;
        const secondWaitMs = Math.max(0, totalWaitMs - offDelay - firstWaitMs);
        await waitForAdEnd();
        const secondWaiting = adapter.waitForTimedText(
          secondWaitMs,
          signal,
          options.onAdWaiting,
        );
        await adapter.reloadCaptions(track);
        captured = await secondWaiting;
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      failure = diagnosticError(error);
    }
    const forcedResult = await tryCapturedOrRefetch(captured);
    if (forcedResult) return forcedResult;
  }

  try {
    await waitForAdEnd();
    const screenCues = await adapter.readScreen(screenTimeoutMs, options.signal);
    if (screenCues.length)
      return result(3, screenCues, failure);
  } catch (error) {
    if (signal?.aborted) throw error;
    failure = diagnosticError(error);
  }
  return result(4, [], failure || "NoSubtitles");
}

type MainRequestType = "tracks" | "enable" | "disable" | "reload" | "refetch" | "time" | "seek";
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
  status?: number;
  responseBytes?: number;
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
  tracks: () => Promise<{
    tracks: CaptionTrack[];
    videoId?: string;
    tokenSource?: TokenSource;
  }>;
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
  const cancelTimedTextWaiters = new Set<() => void>();

  function isAdShowing() {
    const player = doc.getElementById("movie_player");
    return !!player?.classList.contains("ad-showing") ||
      !!player?.classList.contains("ad-interrupting");
  }

  function observeAdClass(callback: () => void) {
    const player = doc.getElementById("movie_player");
    if (!player) return () => {};
    const observer = new win.MutationObserver(callback);
    observer.observe(player, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }

  function waitForAdEnd(
    signal?: AbortSignal,
    onWaiting?: (waiting: boolean) => void,
  ) {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new YouTubeCaptionError("Aborted"));
        return;
      }
      let done = false;
      let stopObserving = () => {};
      const finish = (error?: Error) => {
        if (done) return;
        done = true;
        stopObserving();
        signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve();
      };
      const check = () => {
        const waiting = isAdShowing();
        onWaiting?.(waiting);
        if (!waiting) finish();
      };
      const onAbort = () => finish(new YouTubeCaptionError("Aborted"));
      signal?.addEventListener("abort", onAbort, { once: true });
      if (!isAdShowing()) {
        onWaiting?.(false);
        finish();
      } else {
        onWaiting?.(true);
        stopObserving = observeAdClass(check);
        check();
      }
    });
  }

  /** Resolves after `durationMs` of non-ad time, pausing while an ad is active. */
  function activeDelay(
    durationMs: number,
    signal?: AbortSignal,
    onAdStateChange?: (showing: boolean) => void,
  ) {
    return new Promise<number | undefined>((resolve) => {
      let remaining = Math.max(0, durationMs);
      let timer: number | undefined;
      let activeSince = 0;
      let done = false;
      let stopObserving = () => {};
      const finish = (elapsed: number | undefined) => {
        if (done) return;
        done = true;
        if (timer !== undefined) win.clearTimeout(timer);
        stopObserving();
        signal?.removeEventListener("abort", onAbort);
        resolve(elapsed);
      };
      const start = () => {
        if (done || timer !== undefined || isAdShowing()) return;
        if (remaining <= 0) {
          finish(durationMs);
          return;
        }
        activeSince = Date.now();
        timer = win.setTimeout(() => finish(durationMs), remaining);
      };
      const update = () => {
        const showing = isAdShowing();
        onAdStateChange?.(showing);
        if (showing && timer !== undefined) {
          win.clearTimeout(timer);
          timer = undefined;
          remaining = Math.max(0, remaining - (Date.now() - activeSince));
        } else if (!isAdShowing()) start();
      };
      const onAbort = () => finish(undefined);
      if (signal?.aborted) {
        finish(undefined);
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      stopObserving = observeAdClass(update);
      onAdStateChange?.(isAdShowing());
      start();
    });
  }

  function clearPending() {
    for (const request of pending.values()) win.clearTimeout(request.timer);
    pending.clear();
    for (const cancel of [...cancelTimedTextWaiters]) cancel();
  }

  const onMessage = (event: MessageEvent<unknown>) => {
    if (event.source !== win || !event.data || typeof event.data !== "object")
      return;
    const data = event.data as Partial<MainTimedText> | Partial<MainResponse>;
    if (data.source !== "voka-yt") return;
    if (data.type === "timedtext") {
      const capture = data as MainTimedText;
      if (!isAdShowing())
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
        tokenSource: response.tokenSource === "hook" || response.tokenSource === "resource-timing"
          ? response.tokenSource
          : "none",
      };
    },
    async enable(track) {
      await request("enable", {
        languageCode: track.languageCode,
        ...(track.kind ? { kind: track.kind } : {}),
      });
    },
    waitForTimedText(timeoutMs, signal, onAdStateChange) {
      return new Promise((resolve) => {
        let finished = false;
        const timeoutController = new win.AbortController();
        const finish = (value?: TimedTextCapture) => {
          if (finished) return;
          finished = true;
          timeoutController.abort();
          signal?.removeEventListener("abort", onAbort);
          timedTextWaiters.delete(waiter);
          cancelTimedTextWaiters.delete(cancel);
          stopObserving();
          resolve(value);
        };
        const waiter = (value: TimedTextCapture) => {
          if (!isAdShowing()) finish(value);
        };
        const cancel = () => finish(undefined);
        const onAbort = () => finish(undefined);
        let stopObserving = () => {};
        stopObserving = observeAdClass(() => {});
        timedTextWaiters.add(waiter);
        cancelTimedTextWaiters.add(cancel);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) finish(undefined);
        else void activeDelay(timeoutMs, timeoutController.signal, onAdStateChange).then((elapsed) => {
          if (elapsed !== undefined) finish(undefined);
        });
      });
    },
    isAdShowing,
    waitForAdEnd,
    async getTokenSource() {
      const response = await request("tracks");
      return response.tokenSource === "hook" || response.tokenSource === "resource-timing"
        ? response.tokenSource
        : "none";
    },
    async disableCaptions() {
      await request("disable");
    },
    async reloadCaptions(track) {
      await request("reload", {
        languageCode: track.languageCode,
        ...(track.kind ? { kind: track.kind } : {}),
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
        tokenSource: response.tokenSource === "hook" || response.tokenSource === "resource-timing"
          ? response.tokenSource
          : "none",
        responseBytes: typeof response.responseBytes === "number"
          ? response.responseBytes
          : undefined,
      };
    },
    async readScreen(timeoutMs, signal) {
      let activeRemaining = timeoutMs;
      let firstRead = true;
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
      while ((firstRead || activeRemaining > 0) && !signal?.aborted) {
        await waitForAdEnd(signal);
        firstRead = false;
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
        const elapsed = await activeDelay(Math.min(200, Math.max(1, activeRemaining)), signal);
        if (elapsed === undefined) return [];
        activeRemaining -= elapsed;
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
      for (const cancel of [...cancelTimedTextWaiters]) cancel();
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
  let tokenSource: TokenSource = "none";
  let httpStatus: number | undefined;
  let responseBytes: number | undefined;
  let retryCount = 0;
  let adWaiting = false;
  let retryCleanup: (() => void) | undefined;
  let acquisitionState: CaptionAcquisitionState = { forcedRefreshUsed: false };

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
      const diagnostic = formatText(
        "youtubeDiagnosticLine",
        "方法 $1 · $2 条 · $3 · 广告 $4 · 令牌 $5 · HTTP $6 · 长度 $7 · 重试 $8",
        [
          String(method ?? 4),
          String(cues.length),
          status,
          adapter.isAdShowing?.()
            ? formatText("youtubeDiagnosticYes", "Yes")
            : formatText("youtubeDiagnosticNo", "No"),
          tokenSource,
          httpStatus === undefined ? "-" : String(httpStatus),
          responseBytes === undefined ? "-" : String(responseBytes),
          String(retryCount),
        ],
      );
      line.diagnostic.textContent = adWaiting
        ? `${formatText("youtubeAdWaiting", "Waiting for the ad to finish")} · ${diagnostic}`
        : diagnostic;
    }
    if (adWaiting) line.root.hidden = !diagnosticsEnabled;
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
    retryCleanup?.();
    retryCleanup = undefined;
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
    const message = failure === "NoCaptionTracks"
      ? formatText("youtubeNoSubtitles", "This video has no subtitles")
      : failure === "NoEnglishTrack"
        ? formatText(
            "youtubeNoEnglishSubtitles",
            "This video has no English subtitles",
          )
        : formatText(
            "youtubeNoReadableSubtitles",
            "No readable English subtitles for this video",
          );
    subtitle.text.textContent = message;
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

  function watchForOneRetry(
    player: HTMLElement,
    video: HTMLVideoElement | null,
    epoch: number,
    href: string,
    retry: () => void,
  ) {
    retryCleanup?.();
    let triggered = false;
    let wasAd = adapter.isAdShowing?.() ?? false;
    const run = () => {
      if (
        triggered || epoch !== generation || readHref() !== href ||
        adapter.isAdShowing?.()
      ) return;
      triggered = true;
      retryCleanup?.();
      retryCleanup = undefined;
      retry();
    };
    const observer = new win.MutationObserver(() => {
      const nowAd = adapter.isAdShowing?.() ?? false;
      if (wasAd && !nowAd) run();
      wasAd = nowAd;
    });
    observer.observe(player, { attributes: true, attributeFilter: ["class"] });
    const onPlay = () => run();
    video?.addEventListener("play", onPlay);
    retryCleanup = () => {
      observer.disconnect();
      video?.removeEventListener("play", onPlay);
    };
  }

  async function startCurrentVideo(href: string) {
    const epoch = ++generation;
    const abort = new AbortController();
    abortController = abort;
    closedByUser = false;
    tokenSource = "none";
    httpStatus = undefined;
    responseBytes = undefined;
    retryCount = 0;
    adWaiting = false;
    acquisitionState = { forcedRefreshUsed: false };
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
      tokenSource = current.tokenSource ?? "none";
      const player = uiDocument.getElementById("movie_player");
      if (!player) throw new YouTubeCaptionError("NoPlayer");
      let currentTracksResult = current;

      const runAttempt = async (retry: boolean) => {
        if (retry) currentTracksResult = await currentTracks(abort.signal);
        const track = chooseEnglishTrack(currentTracksResult.tracks);
        const recorder = new ScreenCueRecorder(adapter, uiDocument);
        screenRecorder = recorder;
        const acquisition = await acquireCaptions(
          track,
          {
            enable: (selected) => adapter.enable(selected),
            waitForTimedText: (timeout, signal, onAdStateChange) =>
              adapter.waitForTimedText(timeout, signal, onAdStateChange),
            refetch: (selected) => adapter.refetch(selected),
            readScreen: makeScreenReader(recorder),
            isAdShowing: () => adapter.isAdShowing?.() ?? false,
            waitForAdEnd: (signal, onWaiting) =>
              adapter.waitForAdEnd?.(signal, onWaiting) ?? Promise.resolve(),
            getTokenSource: () => adapter.getTokenSource?.() ?? Promise.resolve(tokenSource),
            disableCaptions: adapter.disableCaptions
              ? () => adapter.disableCaptions!()
              : undefined,
            reloadCaptions: adapter.reloadCaptions
              ? (selected) => adapter.reloadCaptions!(selected)
              : undefined,
          },
          {
            timedTextTimeoutMs,
            screenTimeoutMs,
            signal: abort.signal,
            initialTokenSource: currentTracksResult.tokenSource ?? tokenSource,
            state: acquisitionState,
            onAdWaiting: (waiting) => {
              adWaiting = waiting;
              if (waiting && !line) {
                const waitingLine = createLine(player, false);
                waitingLine.root.hidden = !diagnosticsEnabled;
              }
              updateDiagnostic();
            },
          },
        );
        if (epoch !== generation || abort.signal.aborted || readHref() !== href)
          return;
        videoId = currentTracksResult.videoId;
        tokenSource = acquisition.tokenSource;
        httpStatus = acquisition.httpStatus;
        responseBytes = acquisition.responseBytes;
        adWaiting = false;
        setCues(acquisition.cues, acquisition.method, acquisition.scope, acquisition.error);
        if (acquisition.method === 4 || !acquisition.cues.length) {
          if (source && activeSession) activeSession.removeSource(source);
          source = undefined;
          screenRecorder = undefined;
          const failure = acquisition.error ?? "NoSubtitles";
          showNoSubtitles(
            player,
            acquisition.method,
            track ? failure : currentTracksResult.tracks.length ? "NoEnglishTrack" : "NoCaptionTracks",
          );
        } else {
          const subtitle = createLine(player);
          if (!source) {
            source = { kind: "dom", root: subtitle.root, listed: false };
            activeSession?.addSource(source);
          }
          if (acquisition.method !== 3) screenRecorder = undefined;
          startDisplayLoop();
        }
        if (!retry && (acquisition.method === 3 || acquisition.method === 4)) {
          watchForOneRetry(
            player,
            uiDocument.querySelector("video"),
            epoch,
            href,
            () => {
              retryCount = 1;
              updateDiagnostic();
              void runAttempt(true).catch((failure) => {
                if (epoch !== generation || abort.signal.aborted) return;
                const code = diagnosticError(failure);
                tokenSource = currentTracksResult.tokenSource ?? tokenSource;
                setCues([], 4, "none", code);
                showNoSubtitles(player, 4, code);
              });
            },
          );
        }
      };

      const waitingLine = createLine(player, false);
      waitingLine.root.hidden = true;
      await runAttempt(false);
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
    retryCleanup?.();
    retryCleanup = undefined;
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
