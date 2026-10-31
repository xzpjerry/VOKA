import { describe, it, expect, vi } from "vitest";
import { replaceGlossCss, glossRules, updateGlossCss } from "./gloss";
import { css } from "../data/template";
describe("gloss CSS", () => {
  it("preserves user CSS byte-for-byte and switches both ways", () => {
    const original = "/* user */\n" + css + "\n.user { color:red }";
    const target = replaceGlossCss(original, "target");
    expect(target).toBe(
      original.replace(glossRules("native"), glossRules("target")),
    );
    expect(replaceGlossCss(target, "native")).toBe(original);
    expect(replaceGlossCss(target, "target")).toBe(target);
  });
  it.each([".user{}", "/* voka:begin */ broken", "/* voka:end */"])(
    "appends safely for missing/incomplete markers: %s",
    (original) => {
      expect(replaceGlossCss(original, "target")).toBe(
        original +
          "\n/* voka:begin */\n" +
          glossRules("target") +
          "\n/* voka:end */",
      );
    },
  );
  it("stores only a CSS update, with no note or structure mutations", async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce([{ name: "VOKA Vocabulary · English" }])
      .mockResolvedValueOnce({ css });
    await updateGlossCss(call, "target");
    expect(call.mock.calls.map((c) => c[0])).toEqual([
      "noteTypes.list",
      "noteTypes.get",
      "noteTypes.update",
    ]);
    expect(call.mock.calls[2]).toEqual([
      "noteTypes.update",
      {
        noteType: { name: "VOKA Vocabulary · English" },
        patch: { css: replaceGlossCss(css, "target") },
      },
      true,
    ]);
  });
  it("does nothing when the type has not been provisioned", async () => {
    const call = vi.fn().mockResolvedValue([]);
    await updateGlossCss(call, "target");
    expect(call).toHaveBeenCalledTimes(1);
  });
});
