type Category = 'humanEnglish' | 'autoEnglishOnly' | 'otherLanguageOnly' | 'noCaptions';
type MethodName = 'methodA' | 'methodB' | 'methodC';
type StoredRecord = {
  label: string;
  category: Category;
  isShorts: boolean;
  methodA: Record<string, unknown>;
  methodB: Record<string, unknown>;
  methodC: Record<string, unknown>;
  playerControl: {
    currentTimeSeconds: number | null;
    eventCounts: Record<string, { voka: number; user: number }>;
    selfTest: { outcome: string; pauseObserved: boolean | null; playObserved: boolean | null };
  };
  spa: { resetHappened: boolean; resetCount: number };
  hoverEpisodes: Array<{ outcome: string; wasPlaying: boolean; pausedByBox: boolean; userChangedState: boolean }>;
  displayModes: Array<{ mode: string; width: number; height: number; overlayContained: boolean }>;
};

const SUMMARY_RECORDS_KEY = 'youtubeProbeRecords';
const SUMMARY_COUNTER_KEY = 'youtubeProbeCounter';
const ALLOWED_FAILURES = new Set([
  'NO_TRACK_URL', 'INVALID_TRACK_URL', 'UNSUPPORTED_TRACK_HOST', 'NO_ENGLISH_TRACK', 'NO_CAPTION_TRACK',
  'FETCH_FAILED', 'TYPE_ERROR', 'HTTP_ERROR', 'NO_CUES', 'NO_TIMEDTEXT_RESPONSE', 'NO_CAPTION_DOM', 'WAITING_FOR_CAPTIONS',
]);
const categoryNames: Record<Category, string> = {
  humanEnglish: '人工英文',
  autoEnglishOnly: '仅自动英文',
  otherLanguageOnly: '仅其他语言',
  noCaptions: '无字幕轨道',
};
const methods: MethodName[] = ['methodA', 'methodB', 'methodC'];
const methodNames: Record<MethodName, string> = { methodA: '方法 A', methodB: '方法 B', methodC: '方法 C' };
const SUMMARY_CATEGORIES: Category[] = ['humanEnglish', 'autoEnglishOnly', 'otherLanguageOnly', 'noCaptions'];

function getRecords(value: unknown): StoredRecord[] {
  return Array.isArray(value) ? value.filter((row): row is StoredRecord => Boolean(row && typeof row === 'object' && typeof (row as StoredRecord).label === 'string')) : [];
}

function sum(values: number[]) { return values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0); }

function numberSummary(values: number[]) {
  return {
    samples: values.length,
    total: sum(values),
    minimum: values.length ? Math.min(...values) : null,
    maximum: values.length ? Math.max(...values) : null,
    mean: values.length ? Number((sum(values) / values.length).toFixed(1)) : null,
  };
}

function booleanCounts(values: unknown[]) {
  return values.reduce<{ yes: number; no: number; unknown: number }>((counts, value) => {
    if (value === true) counts.yes++;
    else if (value === false) counts.no++;
    else counts.unknown++;
    return counts;
  }, { yes: 0, no: 0, unknown: 0 });
}

function methodBucket(records: StoredRecord[], field: MethodName) {
  const bucket = {
    success: 0,
    failure: 0,
    pending: 0,
    reasons: {} as Record<string, number>,
    httpStatusCodes: { json3: {} as Record<string, number>, vtt: {} as Record<string, number>, response: {} as Record<string, number> },
    selectedFormats: { json3: 0, vtt: 0 },
    nonEmpty: { yes: 0, no: 0, unknown: 0 },
    cuesHaveStartAndDuration: { yes: 0, no: 0, unknown: 0 },
    autoWordLevelTiming: { yes: 0, no: 0, unknown: 0 },
    cueCount: numberSummary([] as number[]),
    firstCueMs: numberSummary([] as number[]),
  };
  const cueCounts: number[] = [];
  const firstCueTimes: number[] = [];
  for (const record of records) {
    const method = record[field] ?? {};
    if (method.success === true) bucket.success++;
    else if (method.success === false) bucket.failure++;
    else bucket.pending++;
    if (method.success !== true) {
      const reason = typeof method.reason === 'string' && ALLOWED_FAILURES.has(method.reason) ? method.reason : 'NOT_RECORDED';
      bucket.reasons[reason] = (bucket.reasons[reason] ?? 0) + 1;
    }
    const statusFields = field === 'methodA'
      ? [['json3', method.json3Status], ['vtt', method.vttStatus]] as const
      : [['response', method.httpStatus]] as const;
    for (const [format, status] of statusFields) {
      if (Number.isInteger(status) && Number(status) >= 100 && Number(status) <= 599) {
        const code = String(status);
        const codes = bucket.httpStatusCodes[format];
        codes[code] = (codes[code] ?? 0) + 1;
      }
    }
    if (method.selectedFormat === 'json3' || method.selectedFormat === 'vtt') bucket.selectedFormats[method.selectedFormat]++;
    for (const [key, value] of Object.entries(booleanCounts([method.nonEmpty]))) bucket.nonEmpty[key as keyof typeof bucket.nonEmpty] += value;
    for (const [key, value] of Object.entries(booleanCounts([method.cuesHaveStartAndDuration]))) bucket.cuesHaveStartAndDuration[key as keyof typeof bucket.cuesHaveStartAndDuration] += value;
    for (const [key, value] of Object.entries(booleanCounts([method.autoWordLevelTiming]))) bucket.autoWordLevelTiming[key as keyof typeof bucket.autoWordLevelTiming] += value;
    if (typeof method.cueCount === 'number' && Number.isFinite(method.cueCount)) cueCounts.push(method.cueCount);
    if (typeof method.firstCueMs === 'number' && Number.isFinite(method.firstCueMs)) firstCueTimes.push(method.firstCueMs);
  }
  bucket.cueCount = numberSummary(cueCounts);
  bucket.firstCueMs = numberSummary(firstCueTimes);
  return bucket;
}

function aggregate(records: StoredRecord[]) {
  const counts = Object.fromEntries(SUMMARY_CATEGORIES.map(category => [category, records.filter(record => record.category === category).length])) as Record<Category, number>;
  const byType = Object.fromEntries(SUMMARY_CATEGORIES.map(category => [category, Object.fromEntries(methods.map(method => [method, methodBucket(records.filter(record => record.category === category), method)]))])) as Record<Category, Record<MethodName, ReturnType<typeof methodBucket>>>;
  const events = Object.fromEntries(['play', 'pause', 'seeking', 'seeked'].map(name => [name, {
    voka: sum(records.map(record => record.playerControl?.eventCounts?.[name]?.voka ?? 0)),
    user: sum(records.map(record => record.playerControl?.eventCounts?.[name]?.user ?? 0)),
  }]));
  const selfTests = { passed: 0, interruptedByUser: 0, eventMissing: 0, pending: 0 };
  for (const record of records) {
    const outcome = record.playerControl?.selfTest?.outcome;
    if (outcome === 'passed') selfTests.passed++;
    else if (outcome === 'interruptedByUser') selfTests.interruptedByUser++;
    else if (outcome === 'eventMissing') selfTests.eventMissing++;
    else selfTests.pending++;
  }
  const hover = { resumed: 0, keptPausedAfterUserAction: 0, pauseFailed: 0, notPausedInitially: 0 };
  for (const record of records) for (const episode of record.hoverEpisodes ?? []) {
    if (episode.outcome in hover) hover[episode.outcome as keyof typeof hover]++;
  }
  const displayModes = Object.fromEntries(['theater', 'fullscreen'].map(mode => {
    const rows = records.flatMap(record => record.displayModes ?? []).filter(sample => sample.mode === mode);
    return [mode, {
      samples: rows.length,
      overlayContained: rows.filter(sample => sample.overlayContained).length,
      sizes: rows.map(sample => ({ width: sample.width, height: sample.height, overlayContained: sample.overlayContained })),
    }];
  }));
  return {
    videoCount: records.length,
    captionTypeCounts: counts,
    shortsCount: records.filter(record => record.isShorts).length,
    methodsByCaptionType: byType,
    playerControl: {
      eventsBySource: events,
      selfTests,
      currentTimeSeconds: records.map(record => record.playerControl?.currentTimeSeconds ?? null),
    },
    spa: {
      resets: sum(records.map(record => record.spa?.resetCount ?? 0)),
      videosAfterReset: records.filter(record => record.spa?.resetHappened).length,
    },
    hoverEpisodes: hover,
    displayModes,
  };
}

function appendText(parent: HTMLElement, text: string, className?: string) {
  const node = document.createElement('div');
  node.textContent = text;
  if (className) node.className = className;
  parent.append(node);
  return node;
}

function renderChecklist(records: StoredRecord[]) {
  const list = document.getElementById('checklist')!;
  list.replaceChildren();
  const requirements: Array<{ text: string; count: number; needed: number }> = [
    { text: '人工英文字幕', count: records.filter(record => record.category === 'humanEnglish').length, needed: 5 },
    { text: '仅自动英文字幕', count: records.filter(record => record.category === 'autoEnglishOnly').length, needed: 5 },
    { text: '仅其他语言字幕', count: records.filter(record => record.category === 'otherLanguageOnly').length, needed: 2 },
    { text: '无字幕', count: records.filter(record => record.category === 'noCaptions').length, needed: 2 },
    { text: 'Shorts', count: records.filter(record => record.isShorts).length, needed: 1 },
  ];
  for (const item of requirements) {
    const li = document.createElement('li');
    const complete = item.count >= item.needed;
    li.className = complete ? 'ok' : 'pending';
    li.textContent = `${complete ? '✓' : '○'} ${item.text}: ${item.count}/${item.needed}`;
    list.append(li);
  }
}

function renderMethods(records: StoredRecord[]) {
  const body = document.getElementById('methods')!;
  body.replaceChildren();
  for (const category of SUMMARY_CATEGORIES) {
    for (const method of methods) {
      const bucket = methodBucket(records.filter(record => record.category === category), method);
      const row = document.createElement('tr');
      const values = [
        categoryNames[category], methodNames[method],
        String(bucket.success), String(bucket.failure), String(bucket.pending),
        Object.entries(bucket.reasons).map(([reason, count]) => `${reason}: ${count}`).join(', ') || '—',
        Object.entries(bucket.httpStatusCodes).flatMap(([format, codes]) => Object.entries(codes).map(([status, count]) => `${format} ${status}: ${count}`)).join(', ') || '—',
        `cues ${bucket.cueCount.samples ? `${bucket.cueCount.minimum}–${bucket.cueCount.maximum} (均值 ${bucket.cueCount.mean})` : '待测'} · 有起止 ${bucket.cuesHaveStartAndDuration.yes}/${bucket.cuesHaveStartAndDuration.no}/${bucket.cuesHaveStartAndDuration.unknown} · 自动词级 ${bucket.autoWordLevelTiming.yes}/${bucket.autoWordLevelTiming.no}/${bucket.autoWordLevelTiming.unknown} · 首 cue ${bucket.firstCueMs.samples ? `${bucket.firstCueMs.minimum}–${bucket.firstCueMs.maximum} ms` : '待测'}`,
      ];
      for (const value of values) {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.append(cell);
      }
      body.append(row);
    }
  }
}

function renderControls(summary: ReturnType<typeof aggregate>, records: StoredRecord[]) {
  const root = document.getElementById('controls')!;
  root.replaceChildren();
  const cards = [
    ['播放器事件', Object.entries(summary.playerControl.eventsBySource).map(([event, counts]) => `${event}: user ${counts.user}, VOKA ${counts.voka}`).join(' · ')],
    ['暂停/播放自测', `通过 ${summary.playerControl.selfTests.passed} · 被用户操作打断 ${summary.playerControl.selfTests.interruptedByUser} · 缺事件 ${summary.playerControl.selfTests.eventMissing} · 待测 ${summary.playerControl.selfTests.pending}`],
    ['SPA 导航', `已记录 ${summary.spa.resets} 次重置；重置后视频 ${summary.spa.videosAfterReset} 个`],
    ['悬停暂停', Object.entries(summary.hoverEpisodes).map(([outcome, count]) => `${outcome}: ${count}`).join(' · ')],
    ['影院模式', modeDescription(summary.displayModes.theater)],
    ['全屏', modeDescription(summary.displayModes.fullscreen)],
  ];
  for (const [title, text] of cards) {
    const card = document.createElement('div');
    card.className = 'card';
    const strong = document.createElement('strong');
    strong.textContent = title;
    card.append(strong, document.createTextNode(text));
    root.append(card);
  }
  const currentTimes = records.filter(record => record.playerControl.currentTimeSeconds !== null)
    .map(record => `${record.label}: ${Number(record.playerControl.currentTimeSeconds).toFixed(1)} s`).join(' · ') || '尚无时间读数';
  const card = document.createElement('div');
  card.className = 'card';
  const strong = document.createElement('strong');
  strong.textContent = '当前时间读数';
  card.append(strong, document.createTextNode(currentTimes));
  root.append(card);
}

function modeDescription(mode: { samples: number; overlayContained: number; sizes: Array<{ width: number; height: number; overlayContained: boolean }> }) {
  const sizes = mode.sizes.slice(-5).map(sample => `${sample.width}×${sample.height}${sample.overlayContained ? ' ✓' : ' ✗'}`).join(', ');
  return `${mode.samples} 次切换 · overlay 在播放器内 ${mode.overlayContained} 次${sizes ? ` · 尺寸 ${sizes}` : ''}`;
}

function renderVideos(records: StoredRecord[]) {
  const root = document.getElementById('videos')!;
  root.replaceChildren();
  for (const record of records) {
    const card = document.createElement('div');
    card.className = 'card';
    const title = document.createElement('strong');
    title.textContent = `${record.label} · ${categoryNames[record.category]}${record.isShorts ? ' · Shorts' : ''}`;
    const details = document.createElement('div');
    details.className = 'small';
    details.textContent = `A: ${methodStatus(record.methodA)} · B: ${methodStatus(record.methodB)} · C: ${record.methodC.success === true ? '成功' : record.methodC.success === false ? `失败 (${String(record.methodC.reason ?? '未分类')})` : '待测'} · SPA reset: ${record.spa.resetHappened ? '是' : '否'} · 自测: ${record.playerControl.selfTest.outcome}`;
    card.append(title, details);
    root.append(card);
  }
}

function methodStatus(method: Record<string, unknown>) {
  if (method.success === true) return `成功 (${String(method.cueCount ?? 0)} cues)`;
  if (method.success === false) return `失败 (${String(method.reason ?? '未分类')})`;
  return '待测';
}

function setNotice(message: string) {
  document.getElementById('notice')!.textContent = message;
}

async function refresh() {
  const stored = await chrome.storage.local.get([SUMMARY_RECORDS_KEY, SUMMARY_COUNTER_KEY]);
  const records = getRecords(stored[SUMMARY_RECORDS_KEY]);
  const summary = aggregate(records);
  renderChecklist(records);
  renderMethods(records);
  renderControls(summary, records);
  renderVideos(records);
  return summary;
}

document.getElementById('copy')!.addEventListener('click', async () => {
  const summary = await refresh();
  const json = JSON.stringify(summary, null, 2);
  try {
    await navigator.clipboard.writeText(json);
    setNotice('已复制汇总 JSON。');
  } catch {
    const area = document.createElement('textarea');
    area.value = json;
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
    setNotice('已复制汇总 JSON。');
  }
});

document.getElementById('clear')!.addEventListener('click', async () => {
  await chrome.storage.local.remove([SUMMARY_RECORDS_KEY, SUMMARY_COUNTER_KEY]);
  setNotice('已清空本扩展保存的匿名测量结果。');
  await refresh();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes[SUMMARY_RECORDS_KEY] || changes[SUMMARY_COUNTER_KEY])) void refresh();
});

void refresh();
