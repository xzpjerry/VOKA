import { buildRefetchUrl, type CaptionTrack } from "./captions";

type PlayerResponse = {
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: unknown[];
    };
  };
  videoDetails?: { videoId?: unknown };
};

type YouTubePlayer = HTMLElement & {
  getPlayerResponse?: () => PlayerResponse | undefined;
  loadModule?: (name: string) => unknown;
  setOption?: (module: string, option: string, value: unknown) => unknown;
};

type RequestMessage = {
  source: "voka-yt-req";
  type: "tracks" | "enable" | "refetch" | "time" | "seek";
  requestId?: string;
  languageCode?: string;
  kind?: string;
  timeSeconds?: number;
};

type HookWindow = Window & {
  __VOKA_YOUTUBE_MAIN_INSTALLED__?: boolean;
};

const hookWindow = window as HookWindow;
if (!hookWindow.__VOKA_YOUTUBE_MAIN_INSTALLED__) {
  hookWindow.__VOKA_YOUTUBE_MAIN_INSTALLED__ = true;

  let latestTimedTextUrl: string | undefined;
  const nativeFetch = window.fetch;
  const xhrUrls = new WeakMap<XMLHttpRequest, string>();

  function timedTextDetails(rawUrl: string) {
    try {
      const url = new URL(rawUrl, location.href);
      if (!url.pathname.includes("/api/timedtext")) return undefined;
      return {
        url: url.toString(),
        lang: url.searchParams.get("lang") ?? undefined,
        kind: url.searchParams.get("kind") ?? undefined,
      };
    } catch {
      return undefined;
    }
  }

  function postTimedText(rawUrl: string, body: string) {
    const details = timedTextDetails(rawUrl);
    if (!details) return;
    latestTimedTextUrl = details.url;
    window.postMessage(
      { source: "voka-yt", type: "timedtext", ...details, body },
      location.origin,
    );
  }

  function requestUrl(input: RequestInfo | URL) {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.toString();
    return input.url;
  }

  window.fetch = function (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = requestUrl(input);
    const details = timedTextDetails(url);
    const response = Reflect.apply(nativeFetch, this, [input, init]) as Promise<Response>;
    if (!details) return response;
    return response.then((value) => {
      void value
        .clone()
        .text()
        .then((body) => postTimedText(details.url, body))
        .catch(() => {});
      return value;
    });
  };

  const xhrPrototype = XMLHttpRequest.prototype;
  const nativeOpen = xhrPrototype.open;
  const nativeSend = xhrPrototype.send;
  xhrPrototype.open = function (
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ): void {
    xhrUrls.set(this, typeof url === "string" ? url : url.toString());
    Reflect.apply(nativeOpen, this, [method, url, ...rest]);
  };
  xhrPrototype.send = function (body?: Document | XMLHttpRequestBodyInit | null): void {
    const rawUrl = xhrUrls.get(this);
    const details = rawUrl ? timedTextDetails(rawUrl) : undefined;
    if (details) {
      this.addEventListener(
        "load",
        () => {
          let responseBody = "";
          try {
            const value = this.responseType === "text" || this.responseType === ""
              ? this.responseText
              : this.response;
            responseBody =
              typeof value === "string" ? value : JSON.stringify(value ?? "");
          } catch {
            return;
          }
          postTimedText(details.url, responseBody);
        },
        { once: true },
      );
    }
    Reflect.apply(nativeSend, this, [body]);
  };

  function player() {
    return document.getElementById("movie_player") as YouTubePlayer | null;
  }

  function response() {
    try {
      return player()?.getPlayerResponse?.();
    } catch {
      return undefined;
    }
  }

  function trackName(value: unknown): string {
    if (typeof value === "string") return value;
    if (!value || typeof value !== "object") return "";
    const name = value as { simpleText?: unknown; runs?: unknown[] };
    if (typeof name.simpleText === "string") return name.simpleText;
    return Array.isArray(name.runs)
      ? name.runs
          .map((run) =>
            run && typeof run === "object" &&
            typeof (run as { text?: unknown }).text === "string"
              ? (run as { text: string }).text
              : "",
          )
          .join("")
      : "";
  }

  function tracks() {
    const current = response();
    const rawTracks = current?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    const result: CaptionTrack[] = Array.isArray(rawTracks)
      ? rawTracks.flatMap((raw) => {
          if (!raw || typeof raw !== "object") return [];
          const item = raw as {
            languageCode?: unknown;
            kind?: unknown;
            name?: unknown;
          };
          if (typeof item.languageCode !== "string") return [];
          return [{
            languageCode: item.languageCode,
            ...(typeof item.kind === "string" ? { kind: item.kind } : {}),
            name: trackName(item.name),
          }];
        })
      : [];
    return {
      tracks: result,
      videoId:
        typeof current?.videoDetails?.videoId === "string"
          ? current.videoDetails.videoId
          : undefined,
    };
  }

  function postReply(message: RequestMessage, values: Record<string, unknown>) {
    window.postMessage(
      {
        source: "voka-yt",
        type: "response",
        requestId: message.requestId,
        requestType: message.type,
        ...values,
      },
      location.origin,
    );
  }

  function errorCode(error: unknown): string {
    if (error instanceof TypeError) return "NetworkError";
    if (error && typeof error === "object" && "name" in error) {
      const name = (error as { name?: unknown }).name;
      if (typeof name === "string" && name !== "Error") return name;
    }
    return "Error";
  }

  async function handleRequest(message: RequestMessage) {
    try {
      if (message.type === "tracks") {
        if (!player()) throw new Error("NoPlayer");
        const current = tracks();
        postReply(message, current);
        return;
      }
      if (message.type === "time") {
        const video = document.querySelector("video");
        if (!video) throw new Error("NoVideo");
        postReply(message, { currentTime: video.currentTime });
        return;
      }
      if (message.type === "seek") {
        const video = document.querySelector("video");
        if (!video) throw new Error("NoVideo");
        if (!Number.isFinite(message.timeSeconds) || (message.timeSeconds ?? -1) < 0)
          throw new Error("InvalidTime");
        video.currentTime = message.timeSeconds!;
        postReply(message, { currentTime: video.currentTime });
        return;
      }
      if (message.type === "enable") {
        if (!message.languageCode) throw new Error("MissingLanguage");
        const current = player();
        if (!current?.loadModule || !current.setOption)
          throw new Error("NoPlayer");
        await current.loadModule("captions");
        await current.setOption("captions", "track", {
          languageCode: message.languageCode,
          ...(message.kind ? { kind: message.kind } : {}),
        });
        postReply(message, { ok: true });
        return;
      }
      if (message.type === "refetch") {
        if (!latestTimedTextUrl) throw new Error("NoTimedTextUrl");
        const track: CaptionTrack = {
          languageCode: message.languageCode ?? "",
          ...(message.kind ? { kind: message.kind } : {}),
        };
        const url = buildRefetchUrl(latestTimedTextUrl, track);
        const response = await window.fetch(url, {
          credentials: "include",
        });
        postReply(message, {
          status: response.status,
          ok: response.ok,
          body: await response.text(),
        });
      }
    } catch (error) {
      postReply(message, { error: errorCode(error) });
    }
  }

  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (event.source !== window) return;
    const message = event.data as Partial<RequestMessage> | null;
    if (
      !message ||
      message.source !== "voka-yt-req" ||
      !["tracks", "enable", "refetch", "time", "seek"].includes(message.type ?? "")
    )
      return;
    void handleRequest(message as RequestMessage);
  });

  window.addEventListener("yt-navigate-start", () => {
    latestTimedTextUrl = undefined;
  });
  window.addEventListener("yt-navigate-finish", () => {
    latestTimedTextUrl = undefined;
  });
}
