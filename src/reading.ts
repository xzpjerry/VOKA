import { normalizeKey } from "./key";
import {
  testPack,
  testInflections,
  testReadingEntries,
} from "./data/test-pack";
export const levels = ["A1", "A2", "B1", "B2", "C1", "C2"] as const;
export type Level = (typeof levels)[number];
export type ReadingSettings = {
  nativeLanguage: "zh" | "en";
  glossLanguage: "native" | "target";
  targetLevel: Level;
  showAdvanced: boolean;
  hoverScope: "highlighted" | "all";
};
export type CardState = { type: string; queue: string; intervalDays: number };
export type WordState = {
  fields: Record<string, string>;
  cards: CardState[];
  level?: string;
};
export type HighlightStyle = "unknown" | "learning" | "target" | "weak";
/** First applicable rule wins; suspended/buried cards use level rules. */
export function highlightRule(
  level: string | undefined,
  config: Pick<ReadingSettings, "targetLevel" | "showAdvanced">,
  state?: WordState,
): HighlightStyle | null {
  if (state?.fields.ManualStatus === "known") return null;
  if (state?.fields.ManualStatus === "unknown") return "unknown";
  const active =
    state?.cards.filter(
      (c) =>
        !["suspended", "buriedByScheduler", "buriedByUser"].includes(c.queue),
    ) ?? [];
  if (
    active.some(
      (c) =>
        ["learning", "relearning"].includes(c.type) ||
        (c.type === "review" && c.intervalDays < 21),
    )
  )
    return "learning";
  if (active.some((c) => c.type === "review" && c.intervalDays >= 21))
    return null;
  if (!level || !levels.includes(level as Level)) return null;
  if (level === config.targetLevel) return "target";
  return levels.indexOf(level as Level) > levels.indexOf(config.targetLevel) &&
    config.showAdvanced
    ? "weak"
    : null;
}
export interface Lemmatizer {
  candidates(surface: string): string[];
}
export const fixtureLemmatizer: Lemmatizer = {
  candidates(surface) {
    const lower = normalizeKey(surface).slice(3);
    return [lower, ...(testInflections[lower] ?? [])];
  },
};
const entries = new Map(
  [...testPack.entries, ...testReadingEntries].map((e) => [
    normalizeKey(e.lemma),
    e,
  ]),
);
export function recognize(
  surface: string,
  lemmatizer: Lemmatizer = fixtureLemmatizer,
  lookupEntry = (key: string) => entries.get(key),
) {
  for (const lemma of lemmatizer.candidates(surface)) {
    const key = normalizeKey(lemma),
      entry = lookupEntry(key);
    if (entry) return { key, entry };
  }
  return null;
}
export const excludedSelector =
  'input,textarea,code,pre,kbd,samp,script,style,nav,footer,[role="navigation"],[hidden],[aria-hidden="true"],#voka-drawer';
export function excluded(element: Element | null): boolean {
  for (let el = element; el; el = el.parentElement) {
    if (el.matches(excludedSelector)) return true;
    const editable = el.getAttribute("contenteditable");
    if (editable !== null && editable.toLowerCase() !== "false") return true;
    const style = getComputedStyle(el);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse" ||
      style.contentVisibility === "hidden" ||
      style.opacity === "0"
    )
      return true;
  }
  return false;
}
export type Token = {
  key: string;
  entry: {
    lemma: string;
    level: string;
    GlossNative: string;
    GlossTarget: string;
  };
  recognized: boolean;
  range: Range;
  style: HighlightStyle | null;
};
export function extract(root: Node): Token[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      excluded(node.parentElement)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  const segmenter = new Intl.Segmenter("en", { granularity: "word" });
  const tokens: Token[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    for (const part of segmenter.segment(node.textContent ?? "")) {
      if (!part.isWordLike || !/^[\p{L}\p{M}'’-]+$/u.test(part.segment))
        continue;
      const match = recognize(part.segment);
      const word = match ?? {
        key: normalizeKey(part.segment),
        entry: {
          lemma: part.segment.toLowerCase(),
          level: "",
          GlossNative: "",
          GlossTarget: "",
        },
      };
      const range = document.createRange();
      range.setStart(node, part.index);
      range.setEnd(node, part.index + part.segment.length);
      tokens.push({ ...word, recognized: !!match, range, style: null });
    }
  }
  return tokens;
}
export function containsPoint(
  rect: Pick<DOMRect, "left" | "right" | "top" | "bottom">,
  x: number,
  y: number,
) {
  return (
    rect.right > rect.left &&
    rect.bottom > rect.top &&
    x >= rect.left &&
    x < rect.right &&
    y >= rect.top &&
    y < rect.bottom
  );
}
export function hitTest(
  tokens: Token[],
  x: number,
  y: number,
  scope: ReadingSettings["hoverScope"],
) {
  return tokens.find(
    (token) =>
      token.range.startContainer.isConnected &&
      ((scope === "all" && token.recognized) || token.style !== null) &&
      Array.from(token.range.getClientRects()).some((rect) =>
        containsPoint(rect, x, y),
      ) &&
      !excluded(token.range.startContainer.parentElement),
  );
}
export function gloss(
  token: Token,
  config: ReadingSettings,
  state?: WordState,
) {
  const fields = state ? state.fields : token.entry;
  const native =
    config.glossLanguage === "native" && config.nativeLanguage !== "en";
  return (
    (native
      ? fields.GlossNative || fields.GlossTarget
      : fields.GlossTarget || fields.GlossNative) ?? ""
  );
}
