import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import puppeteer, { type Page } from 'puppeteer';

type VideoInput = { id: string; isShort?: boolean };
type Track = {
  languageCode: string;
  kind?: string;
  baseUrl: string;
  vssId?: string;
  name?: { simpleText?: string };
};
type Cue = { start: number; end: number; text: string };
type CueMetrics = {
  cueCount: number;
  cuesHaveStartEnd: boolean;
  wordLevelTiming: boolean | null;
  firstStart: number | null;
  lastEnd: number | null;
  cues: Cue[];
};
type MethodResult = {
  attempted: boolean;
  success: boolean;
  reason?: string;
  httpStatus?: number | null;
  cueCount?: number;
  cuesHaveStartEnd?: boolean | null;
  wordLevelTiming?: boolean | null;
  timeToFirstCueMs?: number | null;
  fullCueList?: boolean | null;
  requiresSignedTrackParameters?: boolean | null;
  format?: string | null;
};
type VideoResult = {
  index: number;
  category: string;
  navStatus: number | null;
  playerStatus?: string;
  methodA: MethodResult;
  methodB: MethodResult;
  methodC: MethodResult;
  playerControl?: Record<string, unknown>;
};

const repoRoot = process.cwd();
const videoListPath = path.join(repoRoot, '.cache', 'youtube', 'videos.json');
const resultPath = path.join(repoRoot, '.cache', 'youtube', 'results.json');
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function parsePayload(body: string, isAuto: boolean): CueMetrics {
  try {
    const payload = JSON.parse(body) as { events?: Array<Record<string, unknown>> };
    if (Array.isArray(payload.events)) {
      const cues = payload.events.flatMap(event => {
        const segments = Array.isArray(event.segs) ? event.segs as Array<Record<string, unknown>> : [];
        const text = segments.map(segment => typeof segment.utf8 === 'string' ? segment.utf8 : '').join('').trim();
        if (!text) return [];
        const start = typeof event.tStartMs === 'number' ? event.tStartMs / 1000 : Number.NaN;
        const duration = typeof event.dDurationMs === 'number' ? event.dDurationMs / 1000 : Number.NaN;
        return [{ start, end: start + duration, text }];
      });
      const startsEnds = cues.length > 0 && cues.every(cue => Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.end >= cue.start);
      const wordSegments = payload.events.some(event => {
        const segments = Array.isArray(event.segs) ? event.segs as Array<Record<string, unknown>> : [];
        return segments.filter(segment => typeof segment.utf8 === 'string' && segment.utf8.trim()).length > 1
          && segments.some(segment => typeof segment.tOffsetMs === 'number');
      });
      return {
        cueCount: cues.length,
        cuesHaveStartEnd: startsEnds,
        wordLevelTiming: isAuto ? wordSegments : null,
        firstStart: cues.length && Number.isFinite(cues[0].start) ? cues[0].start : null,
        lastEnd: cues.length && Number.isFinite(cues.at(-1)?.end) ? cues.at(-1)!.end : null,
        cues,
      };
    }
  } catch {
    // Try WebVTT below. Response bodies are deliberately never persisted.
  }

  const cues: Cue[] = [];
  const lines = body.replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(\d{2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})/);
    if (!match) continue;
    const parseTime = (value: string) => {
      const parts = value.split(':').map(Number);
      if (parts.length === 2) return parts[0] * 60 + parts[1];
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    };
    const text = lines.slice(i + 1).find(line => line.trim())?.replace(/<[^>]*>/g, '').trim() ?? '';
    if (text) cues.push({ start: parseTime(match[1]), end: parseTime(match[2]), text });
  }
  return {
    cueCount: cues.length,
    cuesHaveStartEnd: cues.length > 0,
    wordLevelTiming: isAuto ? /<\d{2}:\d{2}:\d{2}\.\d{3}>/.test(body) : null,
    firstStart: cues[0]?.start ?? null,
    lastEnd: cues.at(-1)?.end ?? null,
    cues,
  };
}

function categoryFor(status: string, tracks: Track[]): string {
  if (status !== 'OK') return 'unclassified-player-gated';
  const english = tracks.filter(track => track.languageCode.toLowerCase().startsWith('en'));
  if (english.some(track => track.kind !== 'asr')) return 'english-human';
  if (english.some(track => track.kind === 'asr')) return 'english-auto-only';
  if (tracks.length) return 'other-language-only';
  return 'no-caption-tracks';
}

function unavailable(reason: string, status: number | null, attempted = false): MethodResult {
  return { attempted, success: false, reason, httpStatus: status };
}

async function fetchCaption(page: Page, baseUrl: string, format: 'json3' | 'vtt') {
  return page.evaluate(async ({ url, format: outputFormat }) => {
    const requestUrl = new URL(url);
    requestUrl.searchParams.set('fmt', outputFormat);
    const started = performance.now();
    try {
      const response = await fetch(requestUrl.toString(), { credentials: 'include' });
      const body = await response.text();
      return { status: response.status, body, elapsedMs: Math.round(performance.now() - started) };
    } catch {
      return { status: null, body: '', elapsedMs: Math.round(performance.now() - started) };
    }
  }, { url: baseUrl, format });
}

async function checkSignedParameters(page: Page, baseUrl: string, format: 'json3' | 'vtt', full: CueMetrics) {
  return page.evaluate(async ({ url, format: outputFormat, expectedCount }) => {
    const candidate = new URL(url);
    const protectedNames = ['signature', 'sig', 'key', 'expire', 'sparams', 'pot', 'xorb', 'xobt'];
    const removed = protectedNames.filter(name => candidate.searchParams.has(name));
    if (!removed.length) return false;
    for (const name of removed) candidate.searchParams.delete(name);
    candidate.searchParams.set('fmt', outputFormat);
    try {
      const response = await fetch(candidate.toString(), { credentials: 'include' });
      if (!response.ok) return true;
      const body = await response.text();
      let count = 0;
      try {
        const payload = JSON.parse(body) as { events?: Array<{ segs?: Array<{ utf8?: string }> }> };
        count = payload.events?.filter(event => event.segs?.some(segment => segment.utf8?.trim())).length ?? 0;
      } catch {
        count = (body.match(/^\d{2}:\d{2}(?::\d{2})?\.\d{3}\s+-->/gm) ?? []).length;
      }
      return count !== expectedCount || count === 0;
    } catch {
      return true;
    }
  }, { url: baseUrl, format, expectedCount: full.cueCount });
}

async function enableTrack(page: Page, track: Track): Promise<boolean> {
  return page.evaluate(selected => {
    const player = document.querySelector('#movie_player') as (HTMLElement & {
      loadModule?: (name: string) => void;
      setOption?: (module: string, option: string, value: unknown) => void;
    }) | null;
    if (!player) return false;
    try {
      player.loadModule?.('captions');
      player.setOption?.('captions', 'track', {
        languageCode: selected.languageCode,
        vssId: selected.vssId,
        kind: selected.kind,
      });
      player.setOption?.('captions', 'reload', true);
    } catch {
      // The documented UI toggle below is the fallback.
    }
    const button = document.querySelector('.ytp-subtitles-button') as HTMLElement | null;
    if (button?.getAttribute('aria-pressed') !== 'true') button?.click();
    return Boolean(button);
  }, { languageCode: track.languageCode, vssId: track.vssId, kind: track.kind });
}

async function captureTimedText(page: Page, track?: Track) {
  const responses: Array<{ status: number; body: string; elapsedMs: number }> = [];
  const started = Date.now();
  await page.evaluate(async () => {
    const video = document.querySelector('video') as HTMLVideoElement | null;
    if (!video) return;
    video.muted = true;
    try { await video.play(); } catch { /* A blocked play is recorded by the missing response. */ }
  }).catch(() => undefined);
  const listener = (response: any) => {
    if (!response.url().includes('/api/timedtext')) return;
    void response.text().then((body: string) => {
      responses.push({ status: response.status(), body, elapsedMs: Date.now() - started });
    }).catch(() => responses.push({ status: response.status(), body: '', elapsedMs: Date.now() - started }));
  };
  page.on('response', listener);
  const enabled = track
    ? await enableTrack(page, track).catch(() => false)
    : await page.$eval('.ytp-subtitles-button', button => { (button as HTMLElement).click(); return true; }).catch(() => false);
  await wait(track ? 9000 : 3000);
  page.off('response', listener);
  const candidates = responses.map(response => ({
    ...response,
    parsed: parsePayload(response.body, track?.kind === 'asr'),
  })).sort((a, b) => b.parsed.cueCount - a.parsed.cueCount);
  return { enabled, response: candidates[0] ?? null };
}

async function readCaptionDom(page: Page) {
  const firstCueStart = Date.now();
  try {
    await page.waitForFunction(() => {
      const video = document.querySelector('video') as HTMLVideoElement | null;
      return Boolean(video && document.querySelector('.ytp-caption-segment')?.textContent?.trim());
    }, { timeout: 8000 });
  } catch {
    return { success: false, reason: 'CAPTION_DOM_EMPTY', timeToFirstCueMs: null, visibleLineCount: 0 };
  }
  const result = await page.evaluate(() => {
    const segments = [...document.querySelectorAll('.ytp-caption-segment')]
      .map(segment => segment.textContent?.trim() ?? '').filter(Boolean);
    const lines = [...document.querySelectorAll('.ytp-caption-window-container .caption-visual-line')]
      .filter(line => line.textContent?.trim()).length;
    return { visibleLineCount: lines || (segments.length ? 1 : 0) };
  });
  return { success: result.visibleLineCount > 0, reason: result.visibleLineCount ? undefined : 'CAPTION_DOM_EMPTY', timeToFirstCueMs: Date.now() - firstCueStart, visibleLineCount: result.visibleLineCount };
}

async function installOverlay(page: Page, cues: Cue[]) {
  return page.evaluate(cueList => {
    const player = document.querySelector('#movie_player') as HTMLElement | null;
    const video = document.querySelector('video') as HTMLVideoElement | null;
    if (!player || !video) return { installed: false };
    const overlay = document.createElement('div');
    overlay.id = 'voka-youtube-research-overlay';
    Object.assign(overlay.style, {
      position: 'absolute', top: '16%', left: '50%', transform: 'translateX(-50%)',
      zIndex: '2147483646', padding: '8px 12px', color: '#fff',
      background: 'rgba(0,0,0,.72)', borderRadius: '6px', font: '16px sans-serif',
      pointerEvents: 'auto', maxWidth: '80%', textAlign: 'center',
    });
    player.append(overlay);
    let pausedByOverlay = false;
    const tick = () => {
      const current = cueList.find(cue => cue.start <= video.currentTime && video.currentTime < cue.end);
      overlay.textContent = current?.text ?? '';
    };
    const timer = window.setInterval(tick, 80);
    overlay.addEventListener('mouseenter', () => {
      if (!video.paused) {
        video.pause();
        pausedByOverlay = true;
      }
    });
    overlay.addEventListener('mouseleave', () => {
      if (pausedByOverlay) {
        pausedByOverlay = false;
        void video.play();
      }
    });
    return { installed: true, timer };
  }, cues);
}

async function verifyOverlay(page: Page, cues: Cue[]) {
  const cueStart = cues[0]?.start ?? null;
  const ready = await page.evaluate(async start => {
    const video = document.querySelector('video') as HTMLVideoElement | null;
    if (!video) return false;
    video.muted = true;
    if (start !== null) video.currentTime = start;
    try { await video.play(); } catch { return false; }
    return true;
  }, cueStart);
  if (!ready) return { installed: false, pauseOnEnter: false, resumeOnLeave: false, preserveUserPause: false, reason: 'VIDEO_PLAY_BLOCKED' };
  await wait(250);
  const rect = await page.$eval('#voka-youtube-research-overlay', el => {
    const box = el.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  }).catch(() => null);
  if (!rect) return { installed: false, pauseOnEnter: false, resumeOnLeave: false, preserveUserPause: false, reason: 'OVERLAY_MISSING' };
  const cueSyncVerified = await page.evaluate(cueList => {
    const video = document.querySelector('video') as HTMLVideoElement | null;
    const overlay = document.querySelector('#voka-youtube-research-overlay');
    if (!video || !overlay) return false;
    const current = cueList.find(cue => cue.start <= video.currentTime && video.currentTime < cue.end);
    return Boolean(current && overlay.textContent === current.text);
  }, cues);
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await wait(250);
  const pausedOnEnter = await page.$eval('video', video => (video as HTMLVideoElement).paused).catch(() => false);
  await page.mouse.move(2, 2);
  await wait(350);
  const resumed = await page.$eval('video', video => !(video as HTMLVideoElement).paused).catch(() => false);
  await page.$eval('video', video => (video as HTMLVideoElement).pause());
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await wait(200);
  await page.mouse.move(2, 2);
  await wait(250);
  const stayedPaused = await page.$eval('video', video => (video as HTMLVideoElement).paused).catch(() => false);
  return { installed: true, cueSyncVerified, pauseOnEnter: pausedOnEnter, resumeOnLeave: resumed, preserveUserPause: stayedPaused };
}

async function testPlayerAndNavigation(page: Page) {
  const initial = await page.evaluate(() => {
    const video = document.querySelector('video') as HTMLVideoElement | null;
    const player = document.querySelector('#movie_player') as (HTMLElement & { getCurrentTime?: () => number; getPlayerState?: () => number }) | null;
    if (!video || !player) return null;
    const existing = (window as any).__vokaResearchEvents as Array<{ name: string; ownAction: string | null; trusted: boolean }> | undefined;
    if (!existing) {
      (window as any).__vokaResearchEvents = [];
      for (const name of ['play', 'pause', 'seeking', 'seeked']) {
        video.addEventListener(name, event => (window as any).__vokaResearchEvents.push({
          name,
          ownAction: (window as any).__vokaResearchOwnAction ?? null,
          trusted: event.isTrusted,
        }));
      }
      (window as any).__vokaResearchSpa = [];
      const record = (event: Event) => (window as any).__vokaResearchSpa.push(event.type);
      window.addEventListener('yt-navigate-start', record);
      window.addEventListener('yt-navigate-finish', record);
      window.addEventListener('popstate', record);
    }
    return { currentTime: video.currentTime, playerCurrentTime: player.getCurrentTime?.() ?? null, playerState: player.getPlayerState?.() ?? null };
  });
  if (!initial) return { success: false, reason: 'PLAYER_OR_VIDEO_MISSING' };
  await page.evaluate(async () => {
    (window as any).__vokaResearchOwnAction = 'script-play';
    (document.querySelector('#movie_player') as any)?.playVideo?.();
    await new Promise(resolve => setTimeout(resolve, 300));
    (window as any).__vokaResearchOwnAction = null;
  });
  await wait(250);
  const scriptPause = await page.evaluate(async () => {
    (window as any).__vokaResearchOwnAction = 'script-pause';
    const player = document.querySelector('#movie_player') as (HTMLElement & { pauseVideo?: () => void }) | null;
    player?.pauseVideo?.();
    await new Promise(resolve => setTimeout(resolve, 300));
    const paused = (document.querySelector('video') as HTMLVideoElement).paused;
    (window as any).__vokaResearchOwnAction = null;
    return paused;
  });
  await page.evaluate(async () => {
    (window as any).__vokaResearchOwnAction = null;
    (window as any).__vokaResearchOwnAction = 'script-play';
    (document.querySelector('#movie_player') as any)?.playVideo?.();
    await new Promise(resolve => setTimeout(resolve, 300));
    (window as any).__vokaResearchOwnAction = null;
  });
  await wait(250);
  const scriptPlay = await page.evaluate(() => !(document.querySelector('video') as HTMLVideoElement).paused);
  const scriptPauseObserved = await page.evaluate(() => {
    const events = (window as any).__vokaResearchEvents as Array<{ name: string; ownAction: string | null }> | undefined;
    return Boolean(events?.some(event => event.name === 'pause' && event.ownAction === 'script-pause'));
  });
  const button = await page.$('.ytp-play-button');
  let userPauseObserved = false;
  let userPlayObserved = false;
  if (button) {
    const beforePause = await page.evaluate(() => (window as any).__vokaResearchEvents?.length ?? 0);
    await page.click('.ytp-play-button');
    await wait(300);
    userPauseObserved = await page.evaluate(before => {
      const events = (window as any).__vokaResearchEvents as Array<{ name: string; ownAction: string | null }> | undefined;
      return Boolean(events?.slice(before).some(event => event.name === 'pause' && event.ownAction === null));
    }, beforePause);
    const beforePlay = await page.evaluate(() => (window as any).__vokaResearchEvents?.length ?? 0);
    await page.click('.ytp-play-button');
    await wait(300);
    userPlayObserved = await page.evaluate(before => {
      const events = (window as any).__vokaResearchEvents as Array<{ name: string; ownAction: string | null }> | undefined;
      return Boolean(events?.slice(before).some(event => event.name === 'play' && event.ownAction === null));
    }, beforePlay);
  }
  const progress = await page.$('.ytp-progress-bar');
  let userSeekObserved = false;
  if (progress) {
    const box = await progress.boundingBox();
    if (box) {
      const beforeSeek = await page.evaluate(() => (window as any).__vokaResearchEvents?.length ?? 0);
      await page.mouse.click(box.x + box.width * 0.65, box.y + box.height / 2);
      await wait(350);
      userSeekObserved = await page.evaluate(before => {
        const events = (window as any).__vokaResearchEvents as Array<{ name: string; ownAction: string | null }> | undefined;
        return Boolean(events?.slice(before).some(event => (event.name === 'seeking' || event.name === 'seeked') && event.ownAction === null));
      }, beforeSeek);
    }
  }
  const hasOverlay = Boolean(await page.$('#voka-youtube-research-overlay'));
  let modeResults = { theater: false, fullscreen: false, overlayContained: false, overlayModeTested: false };
  if (hasOverlay) {
    await page.click('.ytp-size-button').catch(() => undefined);
    await wait(250);
    const theater = await page.$eval('#movie_player', player => player.classList.contains('ytp-big-mode')).catch(() => false);
    const theaterContained = await page.evaluate(() => {
      const player = document.querySelector('#movie_player')?.getBoundingClientRect();
      const overlay = document.querySelector('#voka-youtube-research-overlay')?.getBoundingClientRect();
      return Boolean(player && overlay && overlay.left >= player.left && overlay.right <= player.right && overlay.top >= player.top && overlay.bottom <= player.bottom);
    }).catch(() => false);
    await page.click('.ytp-fullscreen-button').catch(() => undefined);
    await wait(350);
    const fullscreen = await page.evaluate(() => Boolean(document.fullscreenElement) || Boolean(document.querySelector('#movie_player')?.classList.contains('ytp-fullscreen'))).catch(() => false);
    const fullscreenContained = await page.evaluate(() => {
      const player = document.querySelector('#movie_player')?.getBoundingClientRect();
      const overlay = document.querySelector('#voka-youtube-research-overlay')?.getBoundingClientRect();
      return Boolean(player && overlay && overlay.left >= player.left && overlay.right <= player.right && overlay.top >= player.top && overlay.bottom <= player.bottom);
    }).catch(() => false);
    if (fullscreen) await page.click('.ytp-fullscreen-button').catch(() => undefined);
    modeResults = { theater, fullscreen, overlayContained: theaterContained && fullscreenContained, overlayModeTested: true };
  }

  const spaBefore = await page.evaluate(() => (window as any).__vokaResearchSpa?.length ?? 0);
  const navLink = await page.$('a[href^="/watch"], a[href*="/shorts/"]');
  let spaChanged = false;
  if (navLink) {
    await navLink.click().catch(() => undefined);
    await wait(1800);
    spaChanged = await page.evaluate(before => {
      const events = (window as any).__vokaResearchSpa as string[] | undefined;
      return Boolean(events && events.length > before);
    }, spaBefore);
  }
  return {
    success: true,
    currentTimeReadable: typeof initial.currentTime === 'number' && typeof initial.playerCurrentTime === 'number',
    playerStateReadable: typeof initial.playerState === 'number',
    scriptPause,
    scriptPauseEventObserved: scriptPauseObserved,
    scriptPlay,
    userPauseEventObserved: userPauseObserved,
    userPlayEventObserved: userPlayObserved,
    userSeekEventObserved: userSeekObserved,
    spaNavigationEventObserved: spaChanged,
    ...modeResults,
  };
}

async function main() {
  const inputs = JSON.parse(await fs.readFile(videoListPath, 'utf8')) as VideoInput[];
  const videos = inputs.filter(video => typeof video.id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(video.id));
  await fs.mkdir(path.dirname(resultPath), { recursive: true });
  if (videos.length < 15) {
    const summary = {
      probeStatus: 'CANDIDATE_IDS_UNAVAILABLE',
      anonymousCandidateRows: inputs.length,
      usableVideoIds: videos.length,
      reason: 'At least 15 valid IDs must be present in .cache/youtube/videos.json before live probing.',
    };
    await fs.writeFile(resultPath, JSON.stringify({ summary, videos: [] }, null, 2));
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'voka-youtube-fresh-'));
  const results: VideoResult[] = [];
  const controlResults: Record<string, unknown>[] = [];
  let overlayResult: Record<string, unknown> | null = null;
  let consecutivePlayerGates = 0;
  let globalGate: { reason: string; status: number | null } | null = null;
  let controlVideos = 0;

  // `true` selects modern headless Chrome in Puppeteer 25 and uses a fresh profile above.
  const browser = await puppeteer.launch({ headless: true, userDataDir: profile });
  try {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(30000);
    for (let index = 0; index < videos.length; index++) {
      const video = videos[index];
      if (globalGate !== null) {
        const blocked = () => unavailable(`PREVIOUS_${globalGate!.reason}`, globalGate!.status, false);
        results.push({ index: index + 1, category: 'unclassified-player-gated', navStatus: globalGate.status,
          methodA: blocked(), methodB: blocked(), methodC: blocked() });
        continue;
      }

      const navStarted = Date.now();
      let navStatus: number | null = null;
      try {
        const url = video.isShort
          ? new URL(`/shorts/${video.id}`, 'https://www.youtube.com')
          : new URL('/watch', 'https://www.youtube.com');
        if (!video.isShort) url.searchParams.set('v', video.id);
        const response = await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 30000 });
        navStatus = response?.status() ?? null;
      } catch {
        results.push({ index: index + 1, category: 'unclassified-navigation-failed', navStatus,
          methodA: unavailable('NAVIGATION_FAILED', navStatus), methodB: unavailable('NAVIGATION_FAILED', navStatus), methodC: unavailable('NAVIGATION_FAILED', navStatus) });
        continue;
      }
      if (navStatus === 429) {
        globalGate = { reason: 'HTTP_429', status: 429 };
        const failed = () => unavailable('HTTP_429', 429, true);
        results.push({ index: index + 1, category: 'unclassified-http-gated', navStatus,
          methodA: failed(), methodB: failed(), methodC: failed() });
        continue;
      }
      if ((navStatus ?? 0) >= 400) {
        const failed = () => unavailable(`HTTP_${navStatus}`, navStatus, true);
        results.push({ index: index + 1, category: 'unclassified-http-error', navStatus,
          methodA: failed(), methodB: failed(), methodC: failed() });
        continue;
      }

      const pageData = await page.evaluate(() => {
        const player = (window as any).ytInitialPlayerResponse;
        const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
        return {
          status: player?.playabilityStatus?.status ?? 'PLAYER_DATA_UNAVAILABLE',
          tracks: tracks.map((track: Track) => ({
            languageCode: track.languageCode,
            kind: track.kind,
            baseUrl: track.baseUrl,
            vssId: track.vssId,
            name: track.name,
          })) as Track[],
        };
      }).catch(() => ({ status: 'PLAYER_DATA_UNAVAILABLE', tracks: [] as Track[] }));
      const category = categoryFor(pageData.status, pageData.tracks);
      const track = pageData.tracks.find(candidate => candidate.languageCode.toLowerCase().startsWith('en') && candidate.kind !== 'asr')
        ?? pageData.tracks.find(candidate => candidate.languageCode.toLowerCase().startsWith('en'))
        ?? pageData.tracks[0];

      if (pageData.status !== 'OK') {
        consecutivePlayerGates++;
        const reason = `PLAYABILITY_${pageData.status}`;
        const failed = () => unavailable(reason, navStatus, true);
        results.push({ index: index + 1, category, navStatus, playerStatus: pageData.status,
          methodA: failed(), methodB: unavailable(reason, navStatus, false), methodC: unavailable(reason, navStatus, false) });
        if (consecutivePlayerGates >= 3) globalGate = { reason: `PLAYABILITY_${pageData.status}`, status: navStatus };
        continue;
      }
      consecutivePlayerGates = 0;

      if (!track) {
        const captured = await captureTimedText(page);
        const dom = await readCaptionDom(page);
        const methodB = captured.response && captured.response.status === 200 && captured.response.parsed.cueCount > 0
          ? { attempted: true, success: true, httpStatus: captured.response.status, cueCount: captured.response.parsed.cueCount,
              cuesHaveStartEnd: captured.response.parsed.cuesHaveStartEnd, wordLevelTiming: captured.response.parsed.wordLevelTiming,
              timeToFirstCueMs: captured.response.elapsedMs, fullCueList: null }
          : unavailable(captured.response ? `HTTP_${captured.response.status}_OR_EMPTY_CUES` : captured.enabled ? 'NO_TIMEDTEXT_RESPONSE' : 'NO_CAPTION_TRACK', captured.response?.status ?? navStatus, true);
        const methodC = dom.success
          ? { attempted: true, success: true, httpStatus: null, cueCount: dom.visibleLineCount, cuesHaveStartEnd: false,
              wordLevelTiming: null, timeToFirstCueMs: dom.timeToFirstCueMs, fullCueList: false }
          : unavailable(dom.reason ?? 'CAPTION_DOM_EMPTY', navStatus, true);
        const item: VideoResult = { index: index + 1, category, navStatus,
          methodA: unavailable('NO_CAPTION_TRACK', navStatus, true), methodB, methodC };
        if (controlVideos < 2) {
          item.playerControl = await testPlayerAndNavigation(page).catch(() => ({ success: false, reason: 'PLAYER_CONTROL_PROBE_FAILED' }));
          controlResults.push(item.playerControl);
          controlVideos++;
        }
        results.push(item);
        continue;
      }

      const formats: Array<{ format: 'json3' | 'vtt'; status: number | null; parsed: CueMetrics; elapsedMs: number }> = [];
      for (const format of ['json3', 'vtt'] as const) {
        const response = await fetchCaption(page, track.baseUrl, format);
        formats.push({ format, status: response.status, parsed: parsePayload(response.body, track.kind === 'asr'), elapsedMs: response.elapsedMs });
        if (response.status === 429) break;
      }
      formats.sort((left, right) => right.parsed.cueCount - left.parsed.cueCount);
      const direct = formats[0];
      if (direct.status === 429 || formats.some(format => format.status === 429)) {
        globalGate = { reason: 'HTTP_429', status: 429 };
        results.push({ index: index + 1, category, navStatus, playerStatus: pageData.status,
          methodA: unavailable('HTTP_429', 429, true),
          methodB: unavailable('HTTP_429_BEFORE_PLAYER_CAPTURE', 429, false),
          methodC: unavailable('HTTP_429_BEFORE_DOM_READ', 429, false) });
        continue;
      }
      const methodA: MethodResult = direct.status === 200 && direct.parsed.cueCount > 0
        ? {
            attempted: true, success: true, httpStatus: direct.status,
            cueCount: direct.parsed.cueCount, cuesHaveStartEnd: direct.parsed.cuesHaveStartEnd,
            wordLevelTiming: direct.parsed.wordLevelTiming,
            timeToFirstCueMs: direct.elapsedMs,
            fullCueList: true,
            requiresSignedTrackParameters: await checkSignedParameters(page, track.baseUrl, direct.format, direct.parsed),
            format: direct.format,
          }
        : unavailable(direct.status === null ? 'FETCH_FAILED' : `HTTP_${direct.status}_OR_EMPTY_CUES`, direct.status, true);

      const captured = await captureTimedText(page, track);
      const network = captured.response;
      const methodB: MethodResult = network?.status === 429
        ? unavailable('HTTP_429', 429, true)
        : network && network.status === 200 && network.parsed.cueCount > 0
        ? {
            attempted: true, success: true, httpStatus: network.status,
            cueCount: network.parsed.cueCount, cuesHaveStartEnd: network.parsed.cuesHaveStartEnd,
            wordLevelTiming: network.parsed.wordLevelTiming,
            timeToFirstCueMs: network.elapsedMs,
            fullCueList: methodA.success && methodA.cueCount === network.parsed.cueCount,
            requiresSignedTrackParameters: null,
            format: 'player timed-text response',
          }
        : unavailable(network ? `HTTP_${network.status}_OR_EMPTY_CUES` : captured.enabled ? 'NO_TIMEDTEXT_RESPONSE' : 'CAPTION_ENABLE_FAILED', network?.status ?? null, true);
      if (methodA.success && methodB.success) methodA.fullCueList = methodB.fullCueList;

      if (network?.status === 429) {
        globalGate = { reason: 'HTTP_429', status: 429 };
        results.push({ index: index + 1, category, navStatus, playerStatus: pageData.status,
          methodA, methodB, methodC: unavailable('HTTP_429_BEFORE_DOM_READ', 429, false) });
        continue;
      }

      await page.evaluate(async start => {
        const video = document.querySelector('video') as HTMLVideoElement | null;
        if (!video) return;
        video.muted = true;
        if (start !== null) video.currentTime = start;
        try { await video.play(); } catch { /* Method C will record no visible cue. */ }
      }, direct.parsed.firstStart);
      const dom = await readCaptionDom(page);
      const methodC: MethodResult = dom.success
        ? { attempted: true, success: true, httpStatus: null, cueCount: dom.visibleLineCount,
            cuesHaveStartEnd: false, wordLevelTiming: null, timeToFirstCueMs: dom.timeToFirstCueMs, fullCueList: false }
        : unavailable(dom.reason ?? 'CAPTION_DOM_EMPTY', null, true);

      const item: VideoResult = { index: index + 1, category, navStatus, playerStatus: pageData.status, methodA, methodB, methodC };
      if (!overlayResult && methodA.success) {
        const installed = await installOverlay(page, direct.parsed.cues).catch(() => ({ installed: false }));
        overlayResult = installed.installed
          ? await verifyOverlay(page, direct.parsed.cues).catch(() => ({ installed: true, reason: 'OVERLAY_VERIFICATION_FAILED' }))
          : { installed: false, reason: 'OVERLAY_INSTALL_FAILED' };
      }
      if (controlVideos < 2) {
        item.playerControl = await testPlayerAndNavigation(page).catch(() => ({ success: false, reason: 'PLAYER_CONTROL_PROBE_FAILED' }));
        controlResults.push(item.playerControl);
        controlVideos++;
      }
      results.push(item);
      await wait(1000);
    }
  } finally {
    await browser.close();
    await fs.rm(profile, { recursive: true, force: true });
  }

  const methods = ['methodA', 'methodB', 'methodC'] as const;
  const aggregate: Record<string, Record<string, { success: number; failure: number; notAttempted: number; reasons: Record<string, number> }>> = {};
  for (const row of results) {
    aggregate[row.category] ??= {};
    for (const method of methods) {
      const outcome = row[method];
      aggregate[row.category][method] ??= { success: 0, failure: 0, notAttempted: 0, reasons: {} };
      const bucket = aggregate[row.category][method];
      if (!outcome.attempted) bucket.notAttempted++;
      else if (outcome.success) bucket.success++;
      else bucket.failure++;
      if (outcome.reason) bucket.reasons[outcome.reason] = (bucket.reasons[outcome.reason] ?? 0) + 1;
    }
  }

  const summary = {
    sampledVideos: videos.length,
    categoryCounts: results.reduce<Record<string, number>>((counts, row) => {
      counts[row.category] = (counts[row.category] ?? 0) + 1;
      return counts;
    }, {}),
    methods: aggregate,
    playerControlVideos: controlVideos,
    playerControl: controlResults,
    overlay: overlayResult ?? { installed: false, reason: 'NO_DIRECT_CUE_LIST' },
    cleanup: 'Temporary Chrome profile removed; no Anki connection or writes were made.',
  };
  await fs.writeFile(resultPath, JSON.stringify({ summary, videos: results }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

await main();
