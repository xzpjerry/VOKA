import { sentenceAt } from "./contexts";
import { excluded } from "./reading";
import { textBlock } from "./dynamic-reading";
/** Project the containing block to text while keeping the target's exact offset. */
export function sentenceForRange(range: Range) {
  const parent = range.startContainer.parentElement;
  if (!parent || excluded(parent)) throw new Error("无法保存这个区域的例句");
  const block = textBlock(range.startContainer) || parent;
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      excluded(n.parentElement)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  let text = "",
    offset = -1;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node === range.startContainer) offset = text.length + range.startOffset;
    text += node.textContent || "";
  }
  if (offset < 0) throw new Error("例句已变更，请重新选择");
  return sentenceAt(text, offset, range.toString().length);
}
