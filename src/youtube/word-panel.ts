import { escapeHtml, stripFootnotes } from "../contexts";
import type { Token } from "../reading";
import type { ReadingSentence, ReadingSource } from "../reading-session";
import { t } from "../shared";
import type { CaptionCue } from "./captions";
import type { CaptionScope } from "./controller";

type CuesChangedDetail = {
  cues: CaptionCue[];
  scope: CaptionScope;
};

export type YouTubeWordPanelController = {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
  getCues(): CaptionCue[];
  getScope(): CaptionScope;
  seekTo?(timeSeconds: number): void;
};

export type YouTubeWordPanelSession = {
  addSource(source: ReadingSource): void;
  removeSource(source: ReadingSource): void;
  refreshDrawer(): void;
};

export function formatCueTime(startMs: number) {
  const seconds = Math.max(0, Math.floor(Number.isFinite(startMs) ? startMs / 1000 : 0));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(
    seconds % 60,
  ).padStart(2, "0")}`;
}

function cueWordCount(text: string) {
  return [
    ...new Intl.Segmenter("en", { granularity: "word" }).segment(text),
  ].filter((part) => part.isWordLike).length;
}

function truncateAroundTarget(text: string, start: number, length: number) {
  if (text.length <= 300) return { text, start };
  let left = Math.max(0, start - Math.floor((298 - length) / 2));
  let right = Math.min(text.length, left + 298);
  left = Math.max(0, right - 298);
  if (left > 0) while (left < start && /\S/u.test(text[left - 1])) left++;
  if (right < text.length)
    while (right > start + length && /\S/u.test(text[right])) right--;
  const prefix = left > 0 ? "…" : "";
  const suffix = right < text.length ? "…" : "";
  return {
    text: prefix + text.slice(left, right) + suffix,
    start: start - left + prefix.length,
  };
}

/** Use the complete cue; short cues borrow their neighboring cues for context. */
export function cueSentence(
  cues: CaptionCue[],
  cueIndex: number,
  startOffset: number,
  targetLength: number,
): ReadingSentence {
  const cue = cues[cueIndex];
  if (!cue) throw new Error(t("youtubeSentenceChanged"));
  const indexes =
    cueWordCount(cue.text) < 3
      ? [cueIndex - 1, cueIndex, cueIndex + 1].filter(
          (index) => index >= 0 && index < cues.length,
        )
      : [cueIndex];
  const currentPosition = indexes.indexOf(cueIndex);
  const beforeCurrent = indexes
    .slice(0, currentPosition)
    .map((index) => cues[index].text)
    .join(" ");
  const joined = indexes.map((index) => cues[index].text).join(" ");
  const prefix = stripFootnotes(
    beforeCurrent +
      (beforeCurrent ? " " : "") +
      cue.text.slice(0, Math.max(0, startOffset)),
  );
  const surface = stripFootnotes(
    cue.text.slice(startOffset, startOffset + targetLength),
  );
  let clean = stripFootnotes(joined);
  if (!surface || clean.slice(prefix.length, prefix.length + surface.length) !== surface)
    throw new Error(t("youtubeSentenceChanged"));
  let start = prefix.length;
  const leading = clean.length - clean.trimStart().length;
  clean = clean.trim();
  start -= leading;
  const clipped = truncateAroundTarget(clean, start, surface.length);
  clean = clipped.text;
  start = clipped.start;
  if (cueWordCount(clean) < 3)
    throw new Error(t("youtubeSentenceTooShort"));
  const end = start + surface.length;
  const html =
    escapeHtml(clean.slice(0, start)) +
    "<b>" +
    escapeHtml(clean.slice(start, end)) +
    "</b>" +
    escapeHtml(clean.slice(end));
  return { text: clean, html };
}

function appendCueParagraphs(
  container: HTMLDivElement,
  cues: CaptionCue[],
) {
  const fragment = container.ownerDocument.createDocumentFragment();
  cues.forEach((cue, index) => {
    const paragraph = container.ownerDocument.createElement("p");
    paragraph.dataset.startMs = String(cue.startMs);
    paragraph.dataset.cueIndex = String(index);
    paragraph.style.margin = "0";
    paragraph.textContent = cue.text;
    fragment.append(paragraph);
  });
  container.replaceChildren(fragment);
}

/** Build an extractor-readable transcript in the page's light DOM. */
export function buildTranscriptContainer(
  document: Document,
  cues: CaptionCue[],
) {
  const container = document.createElement("div");
  container.id = "voka-transcript";
  container.style.cssText =
    "position:absolute;left:-100000px;top:0;width:1px;overflow:hidden";
  appendCueParagraphs(container, cues);
  return container;
}

function youtubeVideoId(href: string) {
  try {
    const url = new URL(href);
    return (
      url.searchParams.get("v") ||
      (url.pathname.startsWith("/shorts/")
        ? url.pathname.slice("/shorts/".length).split("/")[0]
        : "")
    );
  } catch {
    return "";
  }
}

export function youtubeSourceLabel(
  href: string,
  documentTitle: string,
  startMs: number,
  storeFullUrl: boolean,
) {
  const title =
    documentTitle.replace(/\s+-\s+YouTube\s*$/i, "").trim() ||
    documentTitle.trim() ||
    "YouTube";
  const id = storeFullUrl ? youtubeVideoId(href) : "";
  const seconds = Math.max(0, Math.floor(startMs / 1000));
  const site = id
    ? `https://www.youtube.com/watch?v=${encodeURIComponent(id)}&t=${seconds}s`
    : "youtube.com";
  return { site, title: `${title} · ${formatCueTime(startMs)}` };
}

function rangeElement(token: Token) {
  const node = token.range.startContainer;
  return node.nodeType === 1 ? (node as Element) : node.parentElement;
}

/** Connects controller cues to a transcript source and the existing drawer session. */
export function createYouTubeWordPanel(
  uiDocument: Document,
  readHref: () => string = () => uiDocument.location?.href ?? "",
) {
  let controller: YouTubeWordPanelController | undefined;
  let session: YouTubeWordPanelSession | undefined;
  let transcript: HTMLDivElement | undefined;
  let transcriptSource: ReadingSource | undefined;
  let cues: CaptionCue[] = [];
  let scope: CaptionScope = "none";

  function cueForToken(token: Token) {
    const element = rangeElement(token);
    const paragraph = element?.closest<HTMLParagraphElement>(
      "#voka-transcript p[data-cue-index]",
    );
    if (paragraph) {
      const index = Number(paragraph.dataset.cueIndex);
      const cue = cues[index];
      if (cue)
        return {
          cue,
          index,
          offset: token.range.startOffset,
        };
    }
    const subtitle = element?.closest<HTMLDivElement>("#voka-subtitle");
    if (subtitle) {
      const startMs = Number(subtitle.dataset.startMs);
      const index = cues.findIndex((item) => item.startMs === startMs);
      const cue = index >= 0 ? cues[index] : undefined;
      if (cue && index >= 0)
        return {
          cue,
          index,
          offset: token.range.startOffset,
        };
    }
    return undefined;
  }

  function makeTranscriptSource(root: HTMLDivElement): ReadingSource {
    return {
      kind: "dom",
      root,
      activate(token) {
        const paragraph = rangeElement(token)?.closest<HTMLParagraphElement>(
          "#voka-transcript p[data-start-ms]",
        );
        const startMs = Number(paragraph?.dataset.startMs);
        const video = uiDocument.querySelector("video");
        if (paragraph && Number.isFinite(startMs)) {
          if (controller?.seekTo) controller.seekTo(startMs / 1000);
          else if (video) video.currentTime = startMs / 1000;
        }
      },
      detail(token) {
        const paragraph = rangeElement(token)?.closest<HTMLParagraphElement>(
          "#voka-transcript p[data-start-ms]",
        );
        const startMs = Number(paragraph?.dataset.startMs);
        return paragraph && Number.isFinite(startMs)
          ? formatCueTime(startMs)
          : undefined;
      },
    };
  }

  function clearTranscript() {
    if (transcriptSource) session?.removeSource(transcriptSource);
    transcriptSource = undefined;
    transcript?.remove();
    transcript = undefined;
  }

  function onCuesChanged(event: Event) {
    const detail = (event as CustomEvent<CuesChangedDetail>).detail;
    cues = detail.cues.map((cue) => ({ ...cue }));
    scope = detail.scope;
    if (scope === "none" || !cues.length) {
      clearTranscript();
    } else if (!transcript) {
      transcript = buildTranscriptContainer(uiDocument, cues);
      uiDocument.documentElement.append(transcript);
      transcriptSource = makeTranscriptSource(transcript);
      session?.addSource(transcriptSource);
    } else {
      const updated = buildTranscriptContainer(uiDocument, cues);
      transcript.replaceChildren(...Array.from(updated.childNodes));
    }
    session?.refreshDrawer();
  }

  function bind(next: YouTubeWordPanelController) {
    controller?.removeEventListener("cues-changed", onCuesChanged);
    controller = next;
    controller.addEventListener("cues-changed", onCuesChanged);
    onCuesChanged(
      new CustomEvent<CuesChangedDetail>("cues-changed", {
        detail: { cues: next.getCues(), scope: next.getScope() },
      }),
    );
  }

  function attachSession(next: YouTubeWordPanelSession) {
    session = next;
    if (transcriptSource) session.addSource(transcriptSource);
  }

  function sentenceForToken(token: Token) {
    const found = cueForToken(token);
    return found
      ? cueSentence(
          cues,
          found.index,
          found.offset,
          token.range.toString().length,
        )
      : undefined;
  }

  function sourceLabelForToken(token: Token, storeFullUrl: boolean) {
    const found = cueForToken(token);
    return found
      ? youtubeSourceLabel(
          readHref(),
          uiDocument.title,
          found.cue.startMs,
          storeFullUrl,
        )
      : undefined;
  }

  return {
    bind,
    attachSession,
    sentenceForToken,
    sourceLabelForToken,
    drawerNote: () =>
      scope === "full-track"
        ? t("youtubeScopeWholeVideo")
        : scope === "played-part-only"
          ? t("youtubeScopePlayedPart")
          : undefined,
    stop() {
      controller?.removeEventListener("cues-changed", onCuesChanged);
      controller = undefined;
      clearTranscript();
      session = undefined;
    },
  };
}
