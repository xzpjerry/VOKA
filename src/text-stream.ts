import { normalizeKey } from "./key";
import { excluded, type HighlightStyle, type Token } from "./reading";

const SHOW_TEXT = 4;
const FILTER_ACCEPT = 1;
const FILTER_REJECT = 2;

type TextNodeSegment = {
  node: Text;
  start: number;
  end: number;
};

function collectText(root: Element) {
  const doc = root.ownerDocument ?? (root as unknown as Document);
  const walker = doc.createTreeWalker(root, SHOW_TEXT, {
    acceptNode: (node) =>
      excluded(node.parentElement) ? FILTER_REJECT : FILTER_ACCEPT,
  });
  const segments: TextNodeSegment[] = [];
  let text = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.textContent ?? "";
    if (!value.length) continue;
    segments.push({
      node: node as Text,
      start: text.length,
      end: text.length + value.length,
    });
    text += value;
  }
  return { doc, text, segments };
}

/** Join eligible text nodes and map string offsets back to ranges in their document. */
export function textStream(root: Element): {
  text: string;
  rangeFor(start: number, end: number): Range;
} {
  const { doc, text, segments } = collectText(root);
  const rangeFor = (start: number, end: number) => {
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      start > end ||
      end > text.length
    )
      throw new RangeError("Text stream offsets are out of bounds");

    const range = doc.createRange();
    if (!segments.length) {
      range.setStart(root, 0);
      range.setEnd(root, 0);
      return range;
    }

    if (start === end) {
      const point =
        segments.find((segment) => start >= segment.start && start < segment.end) ??
        (start === text.length ? segments[segments.length - 1] : undefined);
      if (!point) throw new RangeError("Text stream offset has no DOM mapping");
      const offset = Math.min(start - point.start, point.end - point.start);
      range.setStart(point.node, offset);
      range.setEnd(point.node, offset);
      return range;
    }

    const first = segments.find(
      (segment) => start >= segment.start && start < segment.end,
    );
    let last: TextNodeSegment | undefined;
    for (let index = segments.length - 1; index >= 0; index--) {
      const segment = segments[index];
      if (end > segment.start && end <= segment.end) {
        last = segment;
        break;
      }
    }
    if (!first || !last)
      throw new RangeError("Text stream range has no DOM mapping");
    range.setStart(first.node, start - first.start);
    range.setEnd(last.node, end - last.start);
    return range;
  };
  return { text, rangeFor };
}

/** Find a text node boundary in the same eligible stream. */
export function textOffsetFor(
  root: Element,
  node: Node,
  offset: number,
): number | null {
  if (node.nodeType !== 3 || !Number.isInteger(offset) || offset < 0)
    return null;
  const segment = collectText(root).segments.find((item) => item.node === node);
  if (!segment || offset > segment.end - segment.start) return null;
  return segment.start + offset;
}

type StreamMatch = {
  key: string;
  entry: Token["entry"];
  candidates?: Token["entry"][];
};

export type TextStreamSource = {
  document: Document;
  text: string;
  rangeFor(start: number, end: number): Range;
};

/** Extract tokens from the joined text, preserving ranges across split nodes. */
export function extractFromStream(
  root: Element | TextStreamSource,
  recognizeWord: (surface: string) => StreamMatch | null = () => null,
): Token[] {
  const stream =
    "nodeType" in root && root.nodeType === 1
      ? textStream(root as Element)
      : (root as TextStreamSource);
  const segmenter = new Intl.Segmenter("en", { granularity: "word" });
  const tokens: Token[] = [];
  for (const part of segmenter.segment(stream.text)) {
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
    tokens.push({
      ...word,
      recognized: !!match,
      range: stream.rangeFor(part.index, part.index + part.segment.length),
      style: null as HighlightStyle | null,
    });
  }
  return tokens;
}
