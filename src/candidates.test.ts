import { expect, it } from "vitest";
import { selectCandidate } from "./reading";
const entry = (lemma: string, level: string) => ({ lemma, level, GlossNative: "", GlossTarget: "" });
it("selects a sole canonical spelling and handles no candidates", () => {
  expect(selectCandidate("colour", [entry("color", "A1")])?.key).toBe("en:color");
  expect(selectCandidate("x", [])).toBeNull();
});
it("chooses the lowest level regardless of order, before a surface match", () => {
  const candidates = [entry("saw", "B2"), entry("see", "A1"), entry("unknown", "")];
  expect(selectCandidate("saw", candidates)?.key).toBe("en:see");
  expect(candidates[0].lemma).toBe("saw");
  expect(selectCandidate("saw", candidates.reverse())?.key).toBe("en:see");
});
it("breaks level ties in favor of the normalized surface lemma", () => {
  expect(selectCandidate("SAW", [entry("see", "A1"), entry("saw", "A1")])?.key).toBe("en:saw");
  expect(selectCandidate("SAW", [entry("see", ""), entry("saw", "")])?.key).toBe("en:saw");
});
