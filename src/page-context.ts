import { sentenceAt } from "./contexts";
import { excluded } from "./reading";
import { textBlock } from "./dynamic-reading";
import { textOffsetFor, textStream } from "./text-stream";

/** Find the sentence surrounding a DOM selection mapped into a text stream. */
export function sentenceForStream(
  stream: { text: string },
  start: number,
  end: number,
) {
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    end > stream.text.length
  )
    throw new RangeError("Sentence stream offsets are invalid");
  return sentenceAt(stream.text, start, end - start);
}

/** Project the containing block to text while keeping the target's exact offset. */
export function sentenceForRange(range: Range) {
  const doc =
    range.startContainer.ownerDocument ?? (range.startContainer as Document);
  const parent = range.startContainer.parentElement;
  if (!parent || excluded(parent)) throw new Error("无法保存这个区域的例句");
  const block = textBlock(range.startContainer) || parent;
  if (block.ownerDocument !== doc)
    throw new Error("例句已变更，请重新选择");
  const stream = textStream(block);
  const start = textOffsetFor(block, range.startContainer, range.startOffset);
  const end = textOffsetFor(block, range.endContainer, range.endOffset);
  if (start === null || end === null)
    throw new Error("例句已变更，请重新选择");
  return sentenceForStream(stream, start, end);
}
