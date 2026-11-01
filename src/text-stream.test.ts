// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { extractFromStream, textStream } from "./text-stream";

it("extracts a word split across spans as one token with a mapped range", () => {
  document.body.innerHTML =
    '<p id="reader-page"><span>impor</span><span>tant</span></p>';
  const root = document.querySelector("#reader-page")!;
  const tokens = extractFromStream(root, (surface) =>
    surface === "important"
      ? {
          key: "en:important",
          entry: {
            lemma: "important",
            level: "B1",
            GlossNative: "重要的",
            GlossTarget: "having great meaning",
          },
        }
      : null,
  );

  expect(tokens).toHaveLength(1);
  expect(tokens[0].entry.lemma).toBe("important");
  expect(tokens[0].range.toString()).toBe("important");
  expect(tokens[0].range.startContainer.parentElement?.tagName).toBe("SPAN");
  expect(tokens[0].range.endContainer.parentElement?.tagName).toBe("SPAN");
});

it("omits excluded text while building the stream", () => {
  document.body.innerHTML =
    '<p id="reader-page">left <code>private</code> right</p>';
  expect(textStream(document.querySelector("#reader-page")!).text).toBe(
    "left  right",
  );
});
