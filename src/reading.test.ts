// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import {
  highlightRule,
  excluded,
  extract,
  containsPoint,
  hitTest,
  recognize,
  gloss,
  type Token,
} from "./reading";
const config = {
  targetLevel: "B1",
  showAdvanced: false,
  nativeLanguage: "zh",
  glossLanguage: "native",
  hoverScope: "highlighted",
} as const;
const state = (
  type = "new",
  intervalDays = 0,
  queue = type,
  ManualStatus = "",
) => ({ fields: { ManualStatus }, cards: [{ type, queue, intervalDays }] });
describe("highlight precedence", () => {
  it("manual judgments beat scheduling and level", () => {
    expect(
      highlightRule("B1", config, state("learning", 0, "learning", "known")),
    ).toBeNull();
    expect(
      highlightRule("A1", config, state("review", 50, "review", "unknown")),
    ).toBe("unknown");
    expect(
      highlightRule(undefined, config, state("new", 0, "new", "unknown")),
    ).toBe("unknown");
  });
  it.each(["learning", "relearning"])("%s beats level", (type) =>
    expect(highlightRule("A1", config, state(type))).toBe("learning"),
  );
  it("uses the exact 21-day boundary", () => {
    expect(highlightRule("C2", config, state("review", 20))).toBe("learning");
    expect(highlightRule("B1", config, state("review", 21))).toBeNull();
  });
  it("uses level for new, absent, suspended and buried cards", () => {
    for (const card of [
      undefined,
      state(),
      state("review", 99, "suspended"),
      state("learning", 0, "buriedByUser"),
      state("review", 5, "buriedByScheduler"),
    ])
      expect(highlightRule("B1", config, card)).toBe("target");
    expect(highlightRule("A2", config)).toBeNull();
    expect(highlightRule("C1", config)).toBeNull();
    expect(highlightRule("C1", { ...config, showAdvanced: true })).toBe("weak");
    expect(highlightRule(undefined, config)).toBeNull();
  });
});
describe("extraction privacy", () => {
  it.each([
    "input",
    "textarea",
    "code",
    "pre",
    "kbd",
    "samp",
    "script",
    "style",
    "nav",
    "footer",
    'div role="navigation"',
    "div contenteditable",
    'div contenteditable="plaintext-only"',
    "div hidden",
    'div aria-hidden="true"',
    'div style="display:none"',
    'div style="visibility:hidden"',
    'div style="opacity:0"',
  ])("excludes nested %s", (tag) => {
    const name = tag.split(" ")[0];
    document.body.innerHTML =
      name === "input"
        ? '<input value="achieve"><p>achieved improve</p>'
        : `<${tag}><b>achieve</b></${name}><p>achieved improve</p>`;
    expect(
      excluded(document.querySelector("b") ?? document.querySelector(name)),
    ).toBe(true);
    expect(extract(document.body).map((t) => t.entry.lemma)).toEqual([
      "achieve",
      "improve",
    ]);
  });
  it("processes the whole remaining page and allows contenteditable=false", () => {
    document.body.innerHTML =
      '<header>achieve</header><aside>advice</aside><div contenteditable="false">improve</div>';
    expect(extract(document.body)).toHaveLength(3);
  });
  it("matches exact case and fixture inflections", () =>
    expect(recognize("ACHIEVED")?.key).toBe("en:achieve"));
});
describe("range hit testing", () => {
  it("uses individual line rectangles and excludes empty/boundary boxes", () => {
    expect(
      containsPoint({ left: 0, right: 10, top: 0, bottom: 10 }, 5, 5),
    ).toBe(true);
    expect(
      containsPoint({ left: 0, right: 10, top: 0, bottom: 10 }, 10, 5),
    ).toBe(false);
    expect(containsPoint({ left: 0, right: 0, top: 0, bottom: 10 }, 0, 5)).toBe(
      false,
    );
  });
  it("requires highlighted scope, attached nodes and non-excluded regions", () => {
    document.body.innerHTML = "<p>achieve</p>";
    const token = extract(document.body)[0];
    token.range.getClientRects = () =>
      [
        { left: 0, right: 10, top: 0, bottom: 10 },
        { left: 20, right: 30, top: 10, bottom: 20 },
      ] as unknown as DOMRectList;
    expect(hitTest([token], 5, 5, "highlighted")).toBeUndefined();
    expect(hitTest([token], 5, 5, "all")).toBe(token);
    token.style = "target";
    expect(hitTest([token], 25, 15, "highlighted")).toBe(token);
    expect(hitTest([token], 15, 5, "all")).toBeUndefined();
    document.querySelector("p")!.hidden = true;
    expect(hitTest([token], 5, 5, "all")).toBeUndefined();
    document.body.innerHTML = "";
    expect(hitTest([token], 5, 5, "all")).toBeUndefined();
  });
  it("prefers note glosses with fallback, and English native uses target", () => {
    const token = { ...recognize("achieve") } as unknown as Token;
    expect(
      gloss(token, config, {
        fields: { GlossNative: "", GlossTarget: "custom" },
        cards: [],
      }),
    ).toBe("custom");
    expect(gloss(token, { ...config, nativeLanguage: "en" })).toBe(
      token.entry.GlossTarget,
    );
  });
});
