export type CaptionCategory =
  | 'humanEnglish'
  | 'autoEnglishOnly'
  | 'otherLanguageOnly'
  | 'noCaptions';

export type TrackDescriptor = {
  languageCode?: string;
  kind?: string;
  baseUrl?: string;
  vssId?: string;
  name?: { simpleText?: string };
};

export type Cue = { start: number; duration: number; text: string };

export type CueMetrics = {
  nonEmpty: boolean;
  cueCount: number;
  cuesHaveStartAndDuration: boolean;
  autoWordLevelTiming: boolean | null;
  cues: Cue[];
};

export function classifyTracks(tracks: readonly TrackDescriptor[]): CaptionCategory {
  if (!tracks.length) return 'noCaptions';
  const english = tracks.filter(track => (track.languageCode ?? '').toLowerCase().startsWith('en'));
  if (english.some(track => track.kind !== 'asr')) return 'humanEnglish';
  if (english.some(track => track.kind === 'asr')) return 'autoEnglishOnly';
  return 'otherLanguageOnly';
}

function parseTime(value: string): number | null {
  const parts = value.trim().split(':').map(Number);
  if (parts.some(part => !Number.isFinite(part))) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function emptyMetrics(isAuto: boolean): CueMetrics {
  return { nonEmpty: false, cueCount: 0, cuesHaveStartAndDuration: false, autoWordLevelTiming: isAuto ? false : null, cues: [] };
}

function parseJson3(body: string, isAuto: boolean): CueMetrics | null {
  let payload: { events?: Array<Record<string, unknown>> };
  try {
    payload = JSON.parse(body) as typeof payload;
  } catch {
    return null;
  }
  if (!Array.isArray(payload.events)) return null;
  const events = payload.events;
  const cues = events.flatMap(event => {
    const segments = Array.isArray(event.segs) ? event.segs as Array<Record<string, unknown>> : [];
    const text = segments.map(segment => typeof segment.utf8 === 'string' ? segment.utf8 : '').join('').trim();
    if (!text || typeof event.tStartMs !== 'number' || typeof event.dDurationMs !== 'number') return [];
    return [{ start: event.tStartMs / 1000, duration: event.dDurationMs / 1000, text }];
  });
  const wordTiming = isAuto && events.some(event => {
    const segments = Array.isArray(event.segs) ? event.segs as Array<Record<string, unknown>> : [];
    const words = segments.filter(segment => typeof segment.utf8 === 'string' && segment.utf8.trim());
    return words.length > 1
      && words.every(segment => typeof segment.tOffsetMs === 'number')
      && words.every(segment => (segment.utf8 as string).trim().split(/\s+/).length === 1);
  });
  return {
    nonEmpty: body.length > 0,
    cueCount: cues.length,
    cuesHaveStartAndDuration: cues.length > 0 && cues.every(cue => Number.isFinite(cue.start) && Number.isFinite(cue.duration) && cue.duration >= 0),
    autoWordLevelTiming: isAuto ? wordTiming : null,
    cues,
  };
}

function parseVtt(body: string, isAuto: boolean): CueMetrics | null {
  if (!body.includes('-->')) return null;
  const cues: Cue[] = [];
  const blocks = body.replace(/\r/g, '').split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const timeIndex = lines.findIndex(line => line.includes('-->'));
    if (timeIndex < 0) continue;
    const match = lines[timeIndex].match(/([\d:.]+)\s*-->\s*([\d:.]+)/);
    if (!match) continue;
    const start = parseTime(match[1]);
    const end = parseTime(match[2]);
    const text = lines.slice(timeIndex + 1).join(' ').replace(/<[^>]*>/g, '').trim();
    if (start === null || end === null || !text) continue;
    cues.push({ start, duration: Math.max(0, end - start), text });
  }
  const inlineWordTiming = /<\d{2}:\d{2}:\d{2}\.\d{3}>/.test(body);
  return {
    nonEmpty: body.length > 0,
    cueCount: cues.length,
    cuesHaveStartAndDuration: cues.length > 0,
    autoWordLevelTiming: isAuto ? inlineWordTiming : null,
    cues,
  };
}

function parseXml(body: string, isAuto: boolean): CueMetrics | null {
  if (!/<text\b/i.test(body)) return null;
  const cues: Cue[] = [];
  const expression = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
  for (const match of body.matchAll(expression)) {
    const startValue = match[1].match(/\bstart=["']([^"']+)["']/)?.[1];
    const durationValue = match[1].match(/\bdur=["']([^"']+)["']/)?.[1];
    const start = startValue === undefined ? null : Number(startValue);
    const duration = durationValue === undefined ? null : Number(durationValue);
    const text = match[2].replace(/<[^>]*>/g, '').trim();
    if (start === null || duration === null || !Number.isFinite(start) || !Number.isFinite(duration) || !text) continue;
    cues.push({ start, duration, text });
  }
  return {
    nonEmpty: body.length > 0,
    cueCount: cues.length,
    cuesHaveStartAndDuration: cues.length > 0,
    autoWordLevelTiming: isAuto ? false : null,
    cues,
  };
}

export function parseCueBody(body: string, isAuto: boolean): CueMetrics {
  if (!body) return emptyMetrics(isAuto);
  return parseJson3(body, isAuto)
    ?? parseXml(body, isAuto)
    ?? parseVtt(body, isAuto)
    ?? { ...emptyMetrics(isAuto), nonEmpty: true };
}

export function attributeMediaEvent(ownAction: string | null | undefined): 'voka' | 'user' {
  return ownAction ? 'voka' : 'user';
}

export type HoverResumeInput = {
  pausedByBox: boolean;
  videoIsPaused: boolean;
  userEpochAtPause: number;
  currentUserEpoch: number;
};

export function shouldResumeAfterHover(input: HoverResumeInput): boolean {
  return input.pausedByBox
    && input.videoIsPaused
    && input.userEpochAtPause === input.currentUserEpoch;
}

export function hoverOutcome(input: {
  wasPlaying: boolean;
  pausedByBox: boolean;
  resumed: boolean;
  userChangedState: boolean;
}): 'resumed' | 'keptPausedAfterUserAction' | 'pauseFailed' | 'notPausedInitially' {
  if (!input.wasPlaying) return 'notPausedInitially';
  if (!input.pausedByBox) return 'pauseFailed';
  if (input.userChangedState) return 'keptPausedAfterUserAction';
  return input.resumed ? 'resumed' : 'pauseFailed';
}
