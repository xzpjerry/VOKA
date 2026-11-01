import {
  attributeMediaEvent,
  classifyTracks,
  hoverOutcome,
  parseCueBody,
  shouldResumeAfterHover,
  type CaptionCategory,
  type Cue,
  type TrackDescriptor,
} from './logic';

type PlayerResponse = {
  captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: TrackDescriptor[] } };
  playabilityStatus?: { status?: string };
};

type BridgeMessage = { source: 'voka-youtube-probe-main'; type: string; payload: Record<string, unknown> };

type HoverEpisode = {
  wasPlaying: boolean;
  pausedByBox: boolean;
  userEpochAtPause: number;
  resumed: boolean;
};

const pageWindow = window as Window & {
  ytInitialPlayerResponse?: PlayerResponse;
  ytplayer?: { config?: { args?: { player_response?: string } } };
};
const nativeFetch = window.fetch.bind(window);
let bridgeReady = false;
const queuedMessages: BridgeMessage[] = [];

function bridge(type: string, payload: Record<string, unknown> = {}) {
  const message: BridgeMessage = { source: 'voka-youtube-probe-main', type, payload };
  if (!bridgeReady) {
    queuedMessages.push(message);
    return;
  }
  window.postMessage(message, '*');
}

window.addEventListener('message', event => {
  if (event.source !== window || event.data?.source !== 'voka-youtube-probe-isolated' || event.data?.type !== 'ready') return;
  bridgeReady = true;
  for (const message of queuedMessages.splice(0)) window.postMessage(message, '*');
});

function safeStatus(status: number | null) {
  return Number.isInteger(status) && status! >= 100 && status! <= 599 ? status : null;
}

function isTimedTextAddress(raw: string | URL | Request): boolean {
  try {
    const url = raw instanceof Request ? new URL(raw.url) : new URL(String(raw), location.href);
    const host = url.hostname.toLowerCase();
    const allowedHost = host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'googlevideo.com' || host.endsWith('.googlevideo.com');
    return allowedHost && url.pathname.toLowerCase().includes('timedtext');
  } catch {
    return false;
  }
}

const EVENT_NAMES = ['play', 'pause', 'seeking', 'seeked'] as const;
type MediaEventName = typeof EVENT_NAMES[number];
type EventSource = 'voka' | 'user';

type ProbeState = {
  session: number;
  active: boolean;
  playerResponse: PlayerResponse | null;
  previousResponse: PlayerResponse | null;
  awaitingNewResponse: boolean;
  routeFingerprint: string;
  navigationReset: boolean;
  category: CaptionCategory | null;
  tracks: TrackDescriptor[];
  englishTrack: TrackDescriptor | null;
  isAuto: boolean;
  video: HTMLVideoElement | null;
  player: HTMLElement | null;
  cues: Cue[];
  ownAction: string | null;
  expectedOwnEvent: MediaEventName | null;
  ownActionTimer: number | null;
  userEpoch: number;
  eventCounts: Record<MediaEventName, Record<EventSource, number>>;
  currentTime: number | null;
  selfTestAttempted: boolean;
  methodBSeen: boolean;
  methodBReported: boolean;
  methodBArmedAt: number | null;
  methodBTimer: number | null;
  methodCSeen: boolean;
  methodCTimer: number | null;
  currentHover: HoverEpisode | null;
  overlay: HTMLElement | null;
  lastMode: string;
  resizeObserver: ResizeObserver | null;
  domObserver: MutationObserver | null;
  modeObserver: MutationObserver | null;
  playerBindTimer: number | null;
  timeTimer: number | null;
  methodAStarted: boolean;
  videoStartedAt: number;
};

function newEventCounts(): ProbeState['eventCounts'] {
  return {
    play: { voka: 0, user: 0 },
    pause: { voka: 0, user: 0 },
    seeking: { voka: 0, user: 0 },
    seeked: { voka: 0, user: 0 },
  };
}

const state: ProbeState = {
  session: 0,
  active: false,
  playerResponse: null,
  previousResponse: null,
  awaitingNewResponse: false,
  routeFingerprint: `${location.pathname}${location.search}`,
  navigationReset: false,
  category: null,
  tracks: [],
  englishTrack: null,
  isAuto: false,
  video: null,
  player: null,
  cues: [],
  ownAction: null,
  expectedOwnEvent: null,
  ownActionTimer: null,
  userEpoch: 0,
  eventCounts: newEventCounts(),
  currentTime: null,
  selfTestAttempted: false,
  methodBSeen: false,
  methodBReported: false,
  methodBArmedAt: null,
  methodBTimer: null,
  methodCSeen: false,
  methodCTimer: null,
  currentHover: null,
  overlay: null,
  lastMode: 'normal',
  resizeObserver: null,
  domObserver: null,
  modeObserver: null,
  playerBindTimer: null,
  timeTimer: null,
  methodAStarted: false,
  videoStartedAt: 0,
};

let cachedConfigResponseRaw = '';
let cachedConfigResponse: PlayerResponse | null = null;

function currentVideoElement(): HTMLVideoElement | null {
  return document.querySelector('#movie_player video, video.html5-main-video, ytd-player video');
}

function currentPlayerElement(): HTMLElement | null {
  return document.querySelector('#movie_player') as HTMLElement | null
    ?? document.querySelector('ytd-player #player') as HTMLElement | null;
}

function readPlayerResponse(): PlayerResponse | null {
  if (pageWindow.ytInitialPlayerResponse) return pageWindow.ytInitialPlayerResponse;
  const raw = pageWindow.ytplayer?.config?.args?.player_response;
  if (!raw) return null;
  if (raw === cachedConfigResponseRaw) return cachedConfigResponse;
  cachedConfigResponseRaw = raw;
  try {
    cachedConfigResponse = JSON.parse(raw) as PlayerResponse;
    return cachedConfigResponse;
  } catch {
    cachedConfigResponse = null;
    return null;
  }
}

function tracksFrom(response: PlayerResponse): TrackDescriptor[] {
  const tracks = response.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  return Array.isArray(tracks) ? tracks.filter(track => typeof track?.languageCode === 'string') : [];
}

function methodFailure(reason: string) {
  bridge('method-a', {
    session: state.session,
    success: false,
    json3Status: null,
    vttStatus: null,
    nonEmpty: false,
    cueCount: 0,
    cuesHaveStartAndDuration: false,
    autoWordLevelTiming: state.isAuto ? false : null,
    firstCueMs: null,
    selectedFormat: null,
    error: reason,
  });
}

function methodSummary(body: string, status: number | null, isAuto: boolean, firstCueMs: number): Record<string, unknown> {
  const metrics = parseCueBody(body, isAuto);
  const success = safeStatus(status) !== null && status! >= 200 && status! < 300 && metrics.cueCount > 0;
  return {
    success,
    httpStatus: safeStatus(status),
    nonEmpty: metrics.nonEmpty,
    cueCount: metrics.cueCount,
    cuesHaveStartAndDuration: metrics.cuesHaveStartAndDuration,
    autoWordLevelTiming: metrics.autoWordLevelTiming,
    firstCueMs: metrics.cueCount ? firstCueMs : null,
    error: success ? null : safeStatus(status) === null ? 'FETCH_FAILED' : metrics.cueCount ? 'HTTP_ERROR' : 'NO_CUES',
    metrics,
  };
}

async function runMethodA(track: TrackDescriptor) {
  if (state.methodAStarted) return;
  state.methodAStarted = true;
  const session = state.session;
  if (!track.baseUrl) return methodFailure('NO_TRACK_URL');
  let trackUrl: URL;
  try { trackUrl = new URL(track.baseUrl); } catch { return methodFailure('INVALID_TRACK_URL'); }
  if (trackUrl.hostname !== location.hostname || !trackUrl.pathname.toLowerCase().includes('timedtext')) {
    return methodFailure('UNSUPPORTED_TRACK_HOST');
  }

  const startedAt = performance.now();
  const attempt = async (format: 'json3' | 'vtt') => {
    const url = new URL(trackUrl.href);
    url.searchParams.set('fmt', format);
    try {
      const response = await nativeFetch(url.href, { credentials: 'include' });
      const body = await response.text();
      const elapsed = Math.round(performance.now() - startedAt);
      const summary = methodSummary(body, response.status, state.isAuto, elapsed);
      if (summary.success) state.cues = (summary.metrics as ReturnType<typeof parseCueBody>).cues;
      return { status: safeStatus(response.status), body, summary };
    } catch (error) {
      const errorName = error instanceof Error && error.name === 'TypeError' ? 'TYPE_ERROR' : 'FETCH_FAILED';
      return { status: null, body: '', summary: { success: false, httpStatus: null, nonEmpty: false, cueCount: 0, cuesHaveStartAndDuration: false, autoWordLevelTiming: state.isAuto ? false : null, firstCueMs: null, error: errorName } };
    }
  };

  const json3 = await attempt('json3');
  let chosenFormat: 'json3' | 'vtt' = 'json3';
  let selected = json3;
  let vtt: Awaited<ReturnType<typeof attempt>> | null = null;
  if (!json3.summary.success) {
    vtt = await attempt('vtt');
    if (vtt.summary.success) {
      selected = vtt;
      chosenFormat = 'vtt';
    }
  }
  if (state.session !== session) return;
  if (selected.summary.success) {
    state.cues = (selected.summary.metrics as ReturnType<typeof parseCueBody>).cues;
    ensureOverlay();
  }
  bridge('method-a', {
    session,
    success: selected.summary.success,
    json3Status: json3.status,
    vttStatus: vtt?.status ?? null,
    nonEmpty: selected.summary.nonEmpty,
    cueCount: selected.summary.cueCount,
    cuesHaveStartAndDuration: selected.summary.cuesHaveStartAndDuration,
    autoWordLevelTiming: selected.summary.autoWordLevelTiming,
    firstCueMs: selected.summary.firstCueMs,
    selectedFormat: selected.summary.success ? chosenFormat : null,
    error: selected.summary.success ? null : selected.summary.error,
  });
}

function recordMethodB(status: number | null, body: string, requestAt: number, requestSession: number) {
  if (!state.active || requestSession !== state.session || state.methodBSeen || state.methodBArmedAt === null || requestAt < state.methodBArmedAt) return;
  if (state.methodBTimer !== null) clearTimeout(state.methodBTimer);
  state.methodBTimer = null;
  const parsed = parseCueBody(body, state.isAuto);
  const success = safeStatus(status) !== null && status! >= 200 && status! < 300 && parsed.cueCount > 0;
  if (success) {
    state.cues = parsed.cues;
    ensureOverlay();
  }
  if (!state.methodBReported || success) {
    state.methodBSeen = success || state.methodBSeen;
    state.methodBReported = true;
    bridge('method-b', {
      session: state.session,
      success,
      httpStatus: safeStatus(status),
      nonEmpty: body.length > 0,
      cueCount: parsed.cueCount,
      cuesHaveStartAndDuration: parsed.cuesHaveStartAndDuration,
      autoWordLevelTiming: parsed.autoWordLevelTiming,
      firstCueMs: parsed.cueCount ? Math.round(performance.now() - (state.methodBArmedAt ?? state.videoStartedAt)) : null,
      error: success ? null : safeStatus(status) === null ? 'FETCH_FAILED' : parsed.cueCount ? 'HTTP_ERROR' : 'NO_CUES',
    });
  }
}

function wrapPlayerRequests() {
  window.fetch = function patchedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const timedText = isTimedTextAddress(input as string | URL | Request);
    const requestAt = performance.now();
    const requestSession = state.session;
    const promise = nativeFetch(input, init);
    if (timedText) {
      void promise.then(response => {
        response.clone().text().then(body => recordMethodB(response.status, body, requestAt, requestSession)).catch(() => recordMethodB(response.status, '', requestAt, requestSession));
      }).catch(() => recordMethodB(null, '', requestAt, requestSession));
    }
    return promise;
  };

  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;
  const timedTextXhrs = new WeakSet<XMLHttpRequest>();
  XMLHttpRequest.prototype.open = function patchedOpen(method: string, url: string | URL, ...rest: unknown[]) {
    if (isTimedTextAddress(String(url))) timedTextXhrs.add(this);
    else timedTextXhrs.delete(this);
    if (rest.length === 0) return xhrOpen.call(this, method, String(url), true);
    return xhrOpen.call(this, method, String(url), (rest[0] === undefined ? true : rest[0]) as boolean, rest[1] as string, rest[2] as string);
  };
  XMLHttpRequest.prototype.send = function patchedSend(...args: [Document | XMLHttpRequestBodyInit | null] | []) {
    if (timedTextXhrs.has(this)) {
      const requestAt = performance.now();
      const requestSession = state.session;
      this.addEventListener('load', () => {
        let body = '';
        try {
          body = this.responseType === 'json' ? JSON.stringify(this.response ?? '') : this.responseText ?? '';
        } catch { body = ''; }
        recordMethodB(this.status || null, body, requestAt, requestSession);
      }, { once: true });
      this.addEventListener('error', () => recordMethodB(null, '', requestAt, requestSession), { once: true });
    }
    return xhrSend.apply(this, args as [Document | XMLHttpRequestBodyInit | null]);
  };
}

wrapPlayerRequests();

function clearVideoBindings() {
  if (state.playerBindTimer !== null) clearInterval(state.playerBindTimer);
  if (state.timeTimer !== null) clearInterval(state.timeTimer);
  if (state.domObserver) state.domObserver.disconnect();
  if (state.modeObserver) state.modeObserver.disconnect();
  if (state.resizeObserver) state.resizeObserver.disconnect();
  document.removeEventListener('fullscreenchange', recordDisplayMode);
  window.removeEventListener('resize', recordDisplayMode);
  if (state.ownActionTimer !== null) clearTimeout(state.ownActionTimer);
  state.ownActionTimer = null;
  state.ownAction = null;
  state.expectedOwnEvent = null;
  state.playerBindTimer = null;
  state.timeTimer = null;
  state.domObserver = null;
  state.modeObserver = null;
  state.resizeObserver = null;
  state.video = null;
  state.player = null;
  state.overlay?.remove();
  state.overlay = null;
}

function resetForNavigation(cause: 'yt-navigate-finish' | 'url-change' | 'player-change') {
  if (state.awaitingNewResponse) return;
  state.previousResponse = state.playerResponse;
  state.awaitingNewResponse = true;
  state.routeFingerprint = `${location.pathname}${location.search}`;
  state.navigationReset = true;
  state.active = false;
  state.playerResponse = null;
  state.category = null;
  state.tracks = [];
  state.englishTrack = null;
  state.cues = [];
  state.methodAStarted = false;
  state.methodBSeen = false;
  state.methodBReported = false;
  state.methodBArmedAt = null;
  state.methodCSeen = false;
  state.selfTestAttempted = false;
  state.lastMode = 'normal';
  state.currentHover = null;
  state.eventCounts = newEventCounts();
  state.userEpoch = 0;
  if (state.methodBTimer !== null) clearTimeout(state.methodBTimer);
  if (state.methodCTimer !== null) clearTimeout(state.methodCTimer);
  state.methodBTimer = null;
  state.methodCTimer = null;
  clearVideoBindings();
  bridge('spa-reset', { session: state.session + 1, resetHappened: true, cause });
  state.session++;
}

function startVideo(response: PlayerResponse) {
  const session = state.session || 1;
  state.session = session;
  state.active = true;
  state.videoStartedAt = performance.now();
  state.playerResponse = response;
  state.awaitingNewResponse = false;
  state.category = classifyTracks(tracksFrom(response));
  state.tracks = tracksFrom(response);
  state.englishTrack = state.tracks.find(track => (track.languageCode ?? '').toLowerCase().startsWith('en') && track.kind !== 'asr')
    ?? state.tracks.find(track => (track.languageCode ?? '').toLowerCase().startsWith('en'))
    ?? null;
  state.isAuto = state.englishTrack?.kind === 'asr';
  state.currentTime = currentVideoElement()?.currentTime ?? null;
  state.routeFingerprint = `${location.pathname}${location.search}`;
  bridge('video-start', {
    session,
    category: state.category,
    isShorts: location.pathname.startsWith('/shorts/'),
    spaResetHappened: state.navigationReset,
  });
  state.navigationReset = false;
  bindPlayerAndObservers();
  if (state.englishTrack) void runMethodA(state.englishTrack);
  else methodFailure(state.tracks.length ? 'NO_ENGLISH_TRACK' : 'NO_CAPTION_TRACK');
}

function scanPlayer() {
  const response = readPlayerResponse();
  const video = currentVideoElement();
  if (!response) return;
  if (state.active && response !== state.playerResponse) resetForNavigation('player-change');
  if (!state.active) {
    if (state.awaitingNewResponse && response === state.previousResponse) return;
    startVideo(response);
  }
  if (state.active) {
    if (video && video !== state.video) bindVideo(video);
    const player = currentPlayerElement();
    if (player && player !== state.player) bindPlayer(player);
  }
}

function bindPlayerAndObservers() {
  state.playerBindTimer = window.setInterval(scanPlayer, 300);
  scanPlayer();
  state.modeObserver = new MutationObserver(() => recordDisplayMode());
  state.modeObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'theater'] });
  document.addEventListener('fullscreenchange', recordDisplayMode);
  window.addEventListener('resize', recordDisplayMode);
}

function bindPlayer(player: HTMLElement) {
  state.player = player;
  state.resizeObserver?.disconnect();
  state.resizeObserver = new ResizeObserver(() => recordDisplayMode());
  state.resizeObserver.observe(player);
  state.domObserver?.disconnect();
  state.domObserver = new MutationObserver(scanCaptionDom);
  state.domObserver.observe(player, { childList: true, subtree: true, characterData: true });
  scanCaptionDom();
  recordDisplayMode();
  if (state.cues.length) ensureOverlay();
}

function bindVideo(video: HTMLVideoElement) {
  if (state.video === video) return;
  state.video?.removeEventListener('play', onMediaEvent);
  state.video?.removeEventListener('pause', onMediaEvent);
  state.video?.removeEventListener('seeking', onMediaEvent);
  state.video?.removeEventListener('seeked', onMediaEvent);
  state.video?.removeEventListener('timeupdate', onTimeUpdate);
  state.video = video;
  state.currentTime = video.currentTime;
  for (const name of EVENT_NAMES) video.addEventListener(name, onMediaEvent);
  video.addEventListener('timeupdate', onTimeUpdate);
  if (state.timeTimer !== null) clearInterval(state.timeTimer);
  state.timeTimer = window.setInterval(() => {
    if (state.video) {
      state.currentTime = state.video.currentTime;
      bridge('player-snapshot', { session: state.session, currentTimeSeconds: finiteOrNull(state.currentTime) });
    }
    runSelfTestIfPlaying();
  }, 1000);
  runSelfTestIfPlaying();
}

function finiteOrNull(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : null;
}

function eventCountsCopy() {
  return JSON.parse(JSON.stringify(state.eventCounts)) as ProbeState['eventCounts'];
}

function onMediaEvent(event: Event) {
  const name = event.type as MediaEventName;
  if (!EVENT_NAMES.includes(name)) return;
  const own = state.ownAction && state.expectedOwnEvent === name;
  const source = attributeMediaEvent(own ? state.ownAction : null);
  if (own) {
    if (state.ownActionTimer !== null) clearTimeout(state.ownActionTimer);
    state.ownActionTimer = null;
    state.ownAction = null;
    state.expectedOwnEvent = null;
  }
  state.eventCounts[name][source]++;
  state.currentTime = state.video?.currentTime ?? null;
  if (source === 'user') state.userEpoch++;
  bridge('player-event', {
    session: state.session,
    event: name,
    source,
    currentTimeSeconds: finiteOrNull(state.currentTime),
    counts: eventCountsCopy(),
  });
  if (name === 'play') runSelfTestIfPlaying();
}

function onTimeUpdate() {
  state.currentTime = state.video?.currentTime ?? null;
  updateOverlayText();
}

function ownMediaAction(action: string, expectedEvent: MediaEventName, callback: () => unknown) {
  if (state.ownActionTimer !== null) clearTimeout(state.ownActionTimer);
  state.ownAction = action;
  state.expectedOwnEvent = expectedEvent;
  callback();
  state.ownActionTimer = window.setTimeout(() => {
    state.ownAction = null;
    state.expectedOwnEvent = null;
    state.ownActionTimer = null;
  }, 700);
}

function runSelfTestIfPlaying() {
  const video = state.video;
  if (!state.active || !video || video.paused || state.selfTestAttempted) return;
  state.selfTestAttempted = true;
  const pauseBefore = state.eventCounts.pause.voka;
  const playBefore = state.eventCounts.play.voka;
  const userEpochAtStart = state.userEpoch;
  ownMediaAction('selfTestPause', 'pause', () => video.pause());
  window.setTimeout(() => {
    if (!state.active || state.video !== video) return;
    const pauseObserved = state.eventCounts.pause.voka > pauseBefore;
    if (!video.paused || state.userEpoch !== userEpochAtStart) {
      bridge('self-test', {
        session: state.session,
        attempted: true,
        pauseObserved,
        playObserved: false,
        outcome: 'interruptedByUser',
      });
      return;
    }
    ownMediaAction('selfTestPlay', 'play', () => { void video.play(); });
    window.setTimeout(() => {
      if (!state.active || state.video !== video) return;
      bridge('self-test', {
        session: state.session,
        attempted: true,
        pauseObserved,
        playObserved: state.eventCounts.play.voka > playBefore,
        outcome: state.eventCounts.pause.voka > pauseBefore && state.eventCounts.play.voka > playBefore ? 'passed' : 'eventMissing',
      });
    }, 300);
  }, 1000);
}

function methodBHintKey(event: KeyboardEvent) {
  if (event.key.toLowerCase() !== 'c' || event.altKey || event.ctrlKey || event.metaKey || event.repeat) return;
  const target = event.target as HTMLElement | null;
  if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
  if (!state.active) return;
  const session = state.session;
  if (!state.methodCSeen) {
    if (state.methodCTimer !== null) clearTimeout(state.methodCTimer);
    state.methodCTimer = window.setTimeout(() => {
      if (!state.active || state.session !== session || state.methodCSeen) return;
      bridge('method-c', {
        session,
        success: false,
        error: 'NO_CAPTION_DOM',
        lineCount: 0,
        currentTimeSeconds: finiteOrNull(state.video?.currentTime),
      });
    }, 15000);
  }
  if (!state.methodBSeen) {
    state.methodBArmedAt = performance.now();
    if (state.methodBTimer !== null) clearTimeout(state.methodBTimer);
    state.methodBTimer = window.setTimeout(() => {
      if (!state.active || state.session !== session || state.methodBSeen) return;
      state.methodBReported = true;
      bridge('method-b', {
        session,
        success: false,
        httpStatus: null,
        nonEmpty: false,
        cueCount: 0,
        cuesHaveStartAndDuration: false,
        autoWordLevelTiming: state.isAuto ? false : null,
        firstCueMs: null,
        error: 'NO_TIMEDTEXT_RESPONSE',
      });
    }, 15000);
  }
}

window.addEventListener('keydown', methodBHintKey, true);

function scanCaptionDom() {
  if (!state.active || state.methodCSeen) return;
  const segments = [...document.querySelectorAll('.ytp-caption-segment')]
    .filter(element => Boolean(element.textContent?.trim()));
  if (!segments.length) return;
  state.methodCSeen = true;
  if (state.methodCTimer !== null) clearTimeout(state.methodCTimer);
  state.methodCTimer = null;
  const visualLines = [...document.querySelectorAll('.ytp-caption-window-container .caption-visual-line')]
    .filter(element => Boolean(element.textContent?.trim())).length;
  bridge('method-c', {
    session: state.session,
    success: true,
    lineCount: visualLines || 1,
    currentTimeSeconds: finiteOrNull(state.video?.currentTime),
  });
}

function ensureOverlay() {
  const player = state.player ?? currentPlayerElement();
  if (!player || !state.cues.length) return;
  if (state.overlay?.isConnected && state.overlay.parentElement === player) return;
  state.overlay?.remove();
  const box = document.createElement('div');
  box.id = 'voka-youtube-probe-overlay';
  box.setAttribute('aria-live', 'off');
  Object.assign(box.style, {
    position: 'absolute',
    top: '14%',
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: '2147483646',
    maxWidth: '80%',
    padding: '8px 12px',
    borderRadius: '6px',
    background: 'rgba(0,0,0,.78)',
    color: '#fff',
    font: '600 18px/1.4 system-ui,sans-serif',
    textAlign: 'center',
    pointerEvents: 'auto',
  });
  player.append(box);
  state.overlay = box;
  box.addEventListener('mouseenter', onOverlayEnter);
  box.addEventListener('mouseleave', onOverlayLeave);
  updateOverlayText();
  recordDisplayMode();
}

function updateOverlayText() {
  if (!state.overlay || !state.video) return;
  const time = state.video.currentTime;
  const cue = state.cues.find(item => item.start <= time && time < item.start + item.duration);
  state.overlay.textContent = cue?.text ?? '';
  state.overlay.hidden = !cue;
}

function onOverlayEnter() {
  const video = state.video;
  if (!video) return;
  const wasPlaying = !video.paused;
  const episode: HoverEpisode = {
    wasPlaying,
    pausedByBox: false,
    userEpochAtPause: state.userEpoch,
    resumed: false,
  };
  state.currentHover = episode;
  if (wasPlaying) {
    ownMediaAction('overlayPause', 'pause', () => video.pause());
    episode.pausedByBox = video.paused;
  }
}

function onOverlayLeave() {
  const video = state.video;
  const episode = state.currentHover;
  if (!video || !episode) return;
  const userChangedState = state.userEpoch !== episode.userEpochAtPause;
  const shouldResume = shouldResumeAfterHover({
    pausedByBox: episode.pausedByBox,
    videoIsPaused: video.paused,
    userEpochAtPause: episode.userEpochAtPause,
    currentUserEpoch: state.userEpoch,
  });
  if (shouldResume) {
    ownMediaAction('overlayResume', 'play', () => { void video.play(); });
    window.setTimeout(() => {
      episode.resumed = !video.paused;
      finishHover(episode, userChangedState);
    }, 250);
    return;
  }
  finishHover(episode, userChangedState);
}

function finishHover(episode: HoverEpisode, userChangedState: boolean) {
  if (state.currentHover !== episode) return;
  const outcome = hoverOutcome({
    wasPlaying: episode.wasPlaying,
    pausedByBox: episode.pausedByBox,
    resumed: episode.resumed,
    userChangedState,
  });
  bridge('hover', {
    session: state.session,
    outcome,
    wasPlaying: episode.wasPlaying,
    pausedByBox: episode.pausedByBox,
    userChangedState,
  });
  state.currentHover = null;
}

function displayMode() {
  if (document.fullscreenElement) return 'fullscreen';
  const player = state.player;
  const theater = document.querySelector('ytd-watch-flexy[theater]')
    || player?.classList.contains('ytp-big-mode');
  return theater ? 'theater' : 'normal';
}

function recordDisplayMode() {
  const player = state.player ?? currentPlayerElement();
  if (!player) return;
  const mode = displayMode();
  if (mode === state.lastMode) return;
  state.lastMode = mode;
  const bounds = player.getBoundingClientRect();
  const width = Math.max(0, Math.round(bounds.width));
  const height = Math.max(0, Math.round(bounds.height));
  const overlayBounds = state.overlay?.getBoundingClientRect();
  const overlayContained = Boolean(overlayBounds
    && overlayBounds.width > 0
    && overlayBounds.height > 0
    && overlayBounds.left >= bounds.left
    && overlayBounds.right <= bounds.right
    && overlayBounds.top >= bounds.top
    && overlayBounds.bottom <= bounds.bottom);
  bridge('display-mode', { session: state.session, mode, width, height, overlayContained });
}

function beginNavigationWatch() {
  window.addEventListener('yt-navigate-finish', () => {
    const fingerprint = `${location.pathname}${location.search}`;
    if (fingerprint !== state.routeFingerprint || state.active) resetForNavigation('yt-navigate-finish');
    window.setTimeout(scanPlayer, 100);
  }, true);
  window.setInterval(() => {
    const fingerprint = `${location.pathname}${location.search}`;
    if (fingerprint !== state.routeFingerprint) resetForNavigation('url-change');
    scanPlayer();
  }, 300);
}

beginNavigationWatch();
