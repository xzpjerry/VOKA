import { describe, expect, it } from "vitest";
import { manualAction, parseManualStatus } from "./manual";

describe("manual status button", () => {
  it("uses the current highlight to choose known versus unknown", () => {
    expect(manualAction("", true)).toEqual({
      status: "known",
      label: "我认识，别再高亮",
    });
    expect(manualAction(undefined, false)).toEqual({
      status: "unknown",
      label: "我不认识，高亮它",
    });
  });
  it("offers undo only when a manual judgment already exists", () => {
    expect(manualAction("known", true)).toEqual({
      status: "",
      label: "撤销标记",
    });
    expect(manualAction("unknown", false)).toEqual({
      status: "",
      label: "撤销标记",
    });
  });
  it("accepts only empty, known and unknown", () => {
    for (const value of ["", "known", "unknown"])
      expect(parseManualStatus(value)).toBe(value);
    for (const value of ["learning", undefined, null, 1, {}])
      expect(parseManualStatus(value)).toBeUndefined();
  });
});
