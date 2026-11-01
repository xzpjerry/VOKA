type CaptionCategory = 'humanEnglish' | 'autoEnglishOnly' | 'otherLanguageOnly' | 'noCaptions';
type MethodResult = {
  success: boolean | null;
  reason: string | null;
  httpStatus: number | null;
  json3Status: number | null;
  vttStatus: number | null;
  nonEmpty: boolean | null;
  cueCount: number | null;
  cuesHaveStartAndDuration: boolean | null;
  autoWordLevelTiming: boolean | null;
  firstCueMs: number | null;
  selectedFormat: 'json3' | 'vtt' | null;
};
type ProbeEventCounts = Record<'play' | 'pause' | 'seeking' | 'seeked', { voka: number; user: number }>;
type ProbeRecord = {
  label: string;
  category: CaptionCategory;
  isShorts: boolean;
  methodA: MethodResult;
  methodB: MethodResult;
  methodC: { success: boolean | null; reason: string | null; lineCount: number | null; currentTimeSeconds: number | null };
  playerControl: {
    currentTimeSeconds: number | null;
    eventCounts: ProbeEventCounts;
    selfTest: { outcome: string; pauseObserved: boolean | null; playObserved: boolean | null };
  };
  spa: { resetHappened: boolean; resetCount: number };
  hoverEpisodes: Array<{ outcome: string; wasPlaying: boolean; pausedByBox: boolean; userChangedState: boolean }>;
  displayModes: Array<{ mode: 'normal' | 'theater' | 'fullscreen'; width: number; height: number; overlayContained: boolean }>;
};

const CONTENT_RECORDS_KEY = 'youtubeProbeRecords';
const CONTENT_COUNTER_KEY = 'youtubeProbeCounter';
const methodsErrors = new Set([
  'NO_TRACK_URL', 'INVALID_TRACK_URL', 'UNSUPPORTED_TRACK_HOST', 'NO_ENGLISH_TRACK', 'NO_CAPTION_TRACK',
  'FETCH_FAILED', 'TYPE_ERROR', 'HTTP_ERROR', 'NO_CUES', 'NO_TIMEDTEXT_RESPONSE', 'NO_CAPTION_DOM', 'WAITING_FOR_CAPTIONS',
]);
const hoverOutcomes = new Set(['resumed', 'keptPausedAfterUserAction', 'pauseFailed', 'notPausedInitially']);
const selfTestOutcomes = new Set(['pending', 'passed', 'interruptedByUser', 'eventMissing']);
const VALID_CATEGORIES = new Set<CaptionCategory>(['humanEnglish', 'autoEnglishOnly', 'otherLanguageOnly', 'noCaptions']);
const eventNames = ['play', 'pause', 'seeking', 'seeked'] as const;

let activeSession = 0;
let activeLabel: string | null = null;
let nextCounter = 0;
let pendingReset = false;
let writeQueue: Promise<void> = Promise.resolve();
let panelText: HTMLElement | null = null;

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function safeError(value: unknown, allowed: Set<string> = methodsErrors): string | null {
  return typeof value === 'string' && allowed.has(value) ? value : null;
}

function safeStatus(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) >= 100 && Number(value) <= 599 ? Number(value) : null;
}

function emptyMethod(): MethodResult {
  return {
    success: null,
    reason: 'WAITING_FOR_CAPTIONS',
    httpStatus: null,
    json3Status: null,
    vttStatus: null,
    nonEmpty: null,
    cueCount: null,
    cuesHaveStartAndDuration: null,
    autoWordLevelTiming: null,
    firstCueMs: null,
    selectedFormat: null,
  };
}

function emptyEventCounts(): ProbeEventCounts {
  return {
    play: { voka: 0, user: 0 },
    pause: { voka: 0, user: 0 },
    seeking: { voka: 0, user: 0 },
    seeked: { voka: 0, user: 0 },
  };
}

function emptyRecord(label: string, category: CaptionCategory, isShorts: boolean, resetHappened: boolean): ProbeRecord {
  return {
    label,
    category,
    isShorts,
    methodA: emptyMethod(),
    methodB: emptyMethod(),
    methodC: { success: null, reason: 'WAITING_FOR_CAPTIONS', lineCount: null, currentTimeSeconds: null },
    playerControl: {
      currentTimeSeconds: null,
      eventCounts: emptyEventCounts(),
      selfTest: { outcome: 'pending', pauseObserved: null, playObserved: null },
    },
    spa: { resetHappened, resetCount: resetHappened ? 1 : 0 },
    hoverEpisodes: [],
    displayModes: [],
  };
}

async function storageGet(keys: string[]) {
  return chrome.storage.local.get(keys);
}

async function storageSet(values: Record<string, unknown>) {
  await chrome.storage.local.set(values);
}

function enqueueWrite(operation: () => Promise<void>) {
  writeQueue = writeQueue.then(operation).catch(() => undefined);
  return writeQueue;
}

async function currentRecords(): Promise<ProbeRecord[]> {
  const result = await storageGet([CONTENT_RECORDS_KEY]);
  return Array.isArray(result[CONTENT_RECORDS_KEY]) ? result[CONTENT_RECORDS_KEY] as ProbeRecord[] : [];
}

function updatePanel(message: string) {
  if (panelText) panelText.textContent = message;
}

async function beginVideo(payload: Record<string, unknown>) {
  const session = numberOrNull(payload.session);
  const category = typeof payload.category === 'string' && VALID_CATEGORIES.has(payload.category as CaptionCategory)
    ? payload.category as CaptionCategory : null;
  if (session === null || !category) return;
  activeSession = session;
  pendingReset = payload.spaResetHappened === true || pendingReset;
  await enqueueWrite(async () => {
    const stored = await storageGet([CONTENT_RECORDS_KEY, CONTENT_COUNTER_KEY]);
    const records = Array.isArray(stored[CONTENT_RECORDS_KEY]) ? stored[CONTENT_RECORDS_KEY] as ProbeRecord[] : [];
    const counter = Number.isInteger(stored[CONTENT_COUNTER_KEY]) ? Number(stored[CONTENT_COUNTER_KEY]) : 0;
    nextCounter = Math.max(nextCounter, counter) + 1;
    activeLabel = `video #${nextCounter}`;
    records.push(emptyRecord(activeLabel, category, payload.isShorts === true, pendingReset));
    pendingReset = false;
    await storageSet({ [CONTENT_RECORDS_KEY]: records, [CONTENT_COUNTER_KEY]: nextCounter });
    updatePanel(`已记录 ${activeLabel} · ${categoryLabel(category)}`);
  });
}

function categoryLabel(category: CaptionCategory) {
  const names: Record<CaptionCategory, string> = {
    humanEnglish: '人工英文',
    autoEnglishOnly: '仅自动英文',
    otherLanguageOnly: '仅其他语言',
    noCaptions: '无字幕轨道',
  };
  return names[category];
}

function sanitizeMethod(payload: Record<string, unknown>, methodA: boolean): MethodResult {
  const format = payload.selectedFormat === 'json3' || payload.selectedFormat === 'vtt' ? payload.selectedFormat : null;
  return {
    success: booleanOrNull(payload.success),
    reason: safeError(payload.error),
    httpStatus: safeStatus(methodA ? (format === 'json3' ? payload.json3Status : format === 'vtt' ? payload.vttStatus : null) : payload.httpStatus),
    json3Status: methodA ? safeStatus(payload.json3Status) : null,
    vttStatus: methodA ? safeStatus(payload.vttStatus) : null,
    nonEmpty: booleanOrNull(payload.nonEmpty),
    cueCount: numberOrNull(payload.cueCount),
    cuesHaveStartAndDuration: booleanOrNull(payload.cuesHaveStartAndDuration),
    autoWordLevelTiming: booleanOrNull(payload.autoWordLevelTiming),
    firstCueMs: numberOrNull(payload.firstCueMs),
    selectedFormat: methodA ? format : null,
  };
}

function sanitizeCounts(value: unknown): ProbeEventCounts {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const result = emptyEventCounts();
  for (const name of eventNames) {
    const row = source[name] && typeof source[name] === 'object' ? source[name] as Record<string, unknown> : {};
    result[name] = {
      voka: Math.max(0, Math.floor(numberOrNull(row.voka) ?? 0)),
      user: Math.max(0, Math.floor(numberOrNull(row.user) ?? 0)),
    };
  }
  return result;
}

function findActive(records: ProbeRecord[]) {
  if (!activeLabel) return -1;
  return records.findIndex(record => record.label === activeLabel);
}

function updateActive(mutator: (record: ProbeRecord) => ProbeRecord) {
  return enqueueWrite(async () => {
    if (!activeLabel) return;
    const records = await currentRecords();
    const index = findActive(records);
    if (index < 0) return;
    records[index] = mutator(records[index]);
    await storageSet({ [CONTENT_RECORDS_KEY]: records });
  });
}

function applyMessage(type: string, payload: Record<string, unknown>) {
  if (type === 'spa-reset') {
    pendingReset = payload.resetHappened === true;
    return;
  }
  if (type === 'video-start') {
    void beginVideo(payload);
    return;
  }
  if (numberOrNull(payload.session) !== activeSession) return;

  switch (type) {
    case 'method-a':
      void updateActive(record => ({ ...record, methodA: sanitizeMethod(payload, true) }));
      updatePanel(`${activeLabel ?? '视频'} · 方法 A ${payload.success === true ? '成功' : '未取得'}`);
      break;
    case 'method-b':
      void updateActive(record => ({ ...record, methodB: sanitizeMethod(payload, false) }));
      updatePanel(`${activeLabel ?? '视频'} · 方法 B ${payload.success === true ? '已捕获' : '等待字幕响应'}`);
      break;
    case 'method-c':
      void updateActive(record => ({
        ...record,
        methodC: {
          success: booleanOrNull(payload.success) ?? true,
          reason: safeError(payload.error),
          lineCount: Math.max(0, Math.floor(numberOrNull(payload.lineCount) ?? 0)),
          currentTimeSeconds: numberOrNull(payload.currentTimeSeconds),
        },
      }));
      break;
    case 'player-event':
      void updateActive(record => ({
        ...record,
        playerControl: {
          ...record.playerControl,
          currentTimeSeconds: numberOrNull(payload.currentTimeSeconds),
          eventCounts: sanitizeCounts(payload.counts),
        },
      }));
      break;
    case 'player-snapshot':
      void updateActive(record => ({
        ...record,
        playerControl: { ...record.playerControl, currentTimeSeconds: numberOrNull(payload.currentTimeSeconds) },
      }));
      break;
    case 'self-test':
      void updateActive(record => ({
        ...record,
        playerControl: {
          ...record.playerControl,
          selfTest: {
            outcome: selfTestOutcomes.has(String(payload.outcome)) ? String(payload.outcome) : 'eventMissing',
            pauseObserved: booleanOrNull(payload.pauseObserved),
            playObserved: booleanOrNull(payload.playObserved),
          },
        },
      }));
      break;
    case 'hover':
      void updateActive(record => ({
        ...record,
        hoverEpisodes: [...record.hoverEpisodes, {
          outcome: hoverOutcomes.has(String(payload.outcome)) ? String(payload.outcome) : 'pauseFailed',
          wasPlaying: payload.wasPlaying === true,
          pausedByBox: payload.pausedByBox === true,
          userChangedState: payload.userChangedState === true,
        }].slice(-50),
      }));
      break;
    case 'display-mode': {
      const mode: 'normal' | 'theater' | 'fullscreen' = payload.mode === 'theater' || payload.mode === 'fullscreen' ? payload.mode : 'normal';
      void updateActive(record => ({
        ...record,
        displayModes: [...record.displayModes, {
          mode,
          width: Math.max(0, Math.floor(numberOrNull(payload.width) ?? 0)),
          height: Math.max(0, Math.floor(numberOrNull(payload.height) ?? 0)),
          overlayContained: payload.overlayContained === true,
        }].slice(-30),
      }));
      break;
    }
  }
}

function createPanel() {
  const host = document.createElement('div');
  host.id = 'voka-youtube-probe-panel-host';
  Object.assign(host.style, { all: 'initial', position: 'fixed', top: '12px', right: '12px', zIndex: '2147483647' });
  const shadow = host.attachShadow({ mode: 'open' });
  const panel = document.createElement('div');
  Object.assign(panel.style, {
    boxSizing: 'border-box', width: '228px', padding: '9px 11px', borderRadius: '8px',
    background: 'rgba(25,29,36,.94)', color: '#fff', font: '12px/1.4 system-ui,sans-serif',
    boxShadow: '0 2px 12px rgba(0,0,0,.32)', pointerEvents: 'auto',
  });
  const heading = document.createElement('div');
  heading.textContent = 'VOKA 字幕测量';
  heading.style.fontWeight = '700';
  const status = document.createElement('div');
  status.textContent = '等待播放器数据…';
  status.style.marginTop = '3px';
  const hint = document.createElement('div');
  hint.textContent = '按 C 打开字幕以测试方法 B';
  hint.style.marginTop = '5px';
  hint.style.color = '#cbd5e1';
  panel.append(heading, status, hint);
  shadow.append(panel);
  panelText = status;
  return host;
}

const mountPanel = () => {
  if (!document.documentElement || document.getElementById('voka-youtube-probe-panel-host')) return;
  document.documentElement.append(createPanel());
};
mountPanel();
if (!document.documentElement) document.addEventListener('DOMContentLoaded', mountPanel, { once: true });

window.addEventListener('message', event => {
  if (event.source !== window || event.data?.source !== 'voka-youtube-probe-main') return;
  if (typeof event.data.type !== 'string' || !event.data.payload || typeof event.data.payload !== 'object') return;
  applyMessage(event.data.type, event.data.payload as Record<string, unknown>);
});

window.postMessage({ source: 'voka-youtube-probe-isolated', type: 'ready' }, '*');
