// @vitest-environment happy-dom
import { it, expect } from "vitest";
import { sentenceForRange, sentenceForStream } from "./page-context";
import { textStream } from "./text-stream";
function target(html: string) {
  document.body.innerHTML = html;
  const node = document.getElementById("target")!.firstChild!;
  const range = document.createRange();
  range.setStart(node, 0);
  range.setEnd(node, node.textContent!.length);
  return range;
}
it.each(["li", "h2", "td"])(
  "uses containing %s across inline elements without terminal punctuation",
  (tag) => {
    const range = target(
      `<${tag}>A healthy <em id="target">apple</em> snack for everyone</${tag}>`,
    );
    expect(sentenceForRange(range).html).toBe(
      "A healthy <b>apple</b> snack for everyone",
    );
  },
);
it("selects across inline markup and strips footnotes without losing target offsets", () => {
  const range = target(
    '<p>Another sentence. We[1] <em id="target">achieved</em>¹ a difficult goal. Then we left.</p>',
  );
  expect(sentenceForRange(range).html).toBe(
    "We <b>achieved</b> a difficult goal.",
  );
});
it("finds a full sentence when text is split over several spans", () => {
  document.body.innerHTML =
    '<p id="sentence">We <span>ach</span><span>ieved</span> a difficult goal.</p>';
  const root = document.querySelector("#sentence")!;
  const stream = textStream(root);
  const start = stream.text.indexOf("achieved");
  const end = start + "achieved".length;

  expect(sentenceForStream(stream, start, end).html).toBe(
    "We <b>achieved</b> a difficult goal.",
  );
  expect(sentenceForRange(stream.rangeFor(start, end)).html).toBe(
    "We <b>achieved</b> a difficult goal.",
  );
});
it("rejects excluded editable regions", () => {
  expect(() =>
    sentenceForRange(
      target(
        '<p contenteditable="true">We saw an <em id="target">apple</em> today.</p>',
      ),
    ),
  ).toThrow("无法保存");
});
