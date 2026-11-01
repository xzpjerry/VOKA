export type CaptionCue = {
  startMs: number;
  endMs: number;
  text: string;
};

export type CaptionTrack = {
  languageCode: string;
  kind?: string;
  name?: string;
};

export type TimedTextCapture = {
  url: string;
  lang?: string;
  kind?: string;
  body: string;
};

export function parseJson3(body: string): CaptionCue[] {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return [];
  }
  if (!data || typeof data !== "object" || !Array.isArray((data as { events?: unknown }).events))
    return [];

  const cues: CaptionCue[] = [];
  for (const event of (data as { events: unknown[] }).events) {
    if (!event || typeof event !== "object") continue;
    const { tStartMs, dDurationMs, segs } = event as {
      tStartMs?: unknown;
      dDurationMs?: unknown;
      segs?: unknown;
    };
    if (
      typeof tStartMs !== "number" ||
      !Number.isFinite(tStartMs) ||
      !Array.isArray(segs)
    )
      continue;
    const text = segs
      .flatMap((segment) => {
        if (!segment || typeof segment !== "object") return [];
        const utf8 = (segment as { utf8?: unknown }).utf8;
        return typeof utf8 === "string" ? [utf8] : [];
      })
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    const duration =
      typeof dDurationMs === "number" && Number.isFinite(dDurationMs)
        ? Math.max(0, dDurationMs)
        : 0;
    cues.push({
      startMs: Math.max(0, tStartMs),
      endMs: Math.max(0, tStartMs) + duration,
      text,
    });
  }
  return cues;
}

export function chooseEnglishTrack(
  tracks: readonly CaptionTrack[],
): CaptionTrack | undefined {
  const english = tracks.filter((track) =>
    track.languageCode.toLowerCase().startsWith("en"),
  );
  return english.find((track) => track.kind !== "asr") ?? english[0];
}

export function buildRefetchUrl(
  interceptedUrl: string,
  track: CaptionTrack,
): string {
  const url = new URL(interceptedUrl);
  url.searchParams.set("lang", track.languageCode);
  if (track.kind === "asr") url.searchParams.set("kind", "asr");
  else url.searchParams.delete("kind");
  url.searchParams.set("fmt", "json3");
  url.searchParams.delete("tlang");
  return url.toString();
}

export function cueAtTime(
  cues: readonly CaptionCue[],
  timeMs: number,
): CaptionCue | undefined {
  return cues.find(
    (cue) => cue.startMs <= timeMs && timeMs < cue.endMs,
  );
}
