import { normalizeKey } from "./key";
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
export function recognize(
  surface: string,
  lemmatizer: Lemmatizer,
  lookupEntry: (key: string) => Token["entry"] | undefined,
) {
  return selectCandidate(surface, lemmatizer.candidates(surface)
    .map((lemma) => lookupEntry(normalizeKey(lemma)))
    .filter((entry): entry is Token["entry"] => !!entry));
}
/** Pure ADR-0001 selection; ungraded entries sort after all CEFR levels. */
export function selectCandidate(surface: string, entries: Token["entry"][]) {
  const rank = (entry: Token["entry"]) => {
    const index = levels.indexOf(entry.level as Level);
    return index < 0 ? levels.length : index;
  };
  const entry = [...entries].sort((a, b) =>
    rank(a) - rank(b) ||
    Number(normalizeKey(b.lemma) === normalizeKey(surface)) -
      Number(normalizeKey(a.lemma) === normalizeKey(surface)) ||
    a.lemma.localeCompare(b.lemma),
  )[0];
  return entry ? { key: normalizeKey(entry.lemma), entry } : null;
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
    dictionaryStatus?: "found" | "missing";
  };
  candidates?: Token["entry"][];
  recognized: boolean;
  range: Range;
  style: HighlightStyle | null;
};
export function extract(
  root: Node,
  recognizeWord: (surface: string) => ReturnType<typeof recognize> = () => null,
  accept = (_node: Node) => true,
): Token[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      !accept(node) || excluded(node.parentElement)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  const segmenter = new Intl.Segmenter("en", { granularity: "word" });
  const tokens: Token[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    for (const part of segmenter.segment(node.textContent ?? "")) {
      if (
        !part.isWordLike ||
        part.segment.length > 200 ||
        !/^[\p{L}\p{M}'’-]+$/u.test(part.segment)
      )
        continue;
      const match = recognizeWord(part.segment);
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
