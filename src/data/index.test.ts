import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createData, LEVELS } from "./index";
const names = [
  "cefrj",
  "octanove",
  "oewn",
  "readings",
  "oewn-readings",
  "morphology",
];
const packs = names.map((name) =>
  JSON.parse(readFileSync(`public/data/${name}.json`, "utf8")),
);
const data = createData(packs);
describe("production offline data", () => {
  it("keeps two independently licensed level packs and recalculates 1.6 counts", () => {
    expect(packs[0].version).toBe("1.6");
    expect(packs[1].license).toBe("CC-BY-SA-4.0");
    expect(
      LEVELS.map(
        (level) => data.pack.entries.filter((e) => e.level === level).length,
      ),
    ).toEqual([1050, 1200, 2085, 2383, 909, 868]);
    expect(new Set(data.pack.entries.map((e) => e.lemma)).size).toBe(
      data.pack.entries.length,
    );
    expect(
      data.pack.entries.every(
        (e) => e.GlossNative === "" && !/[\s_]/.test(e.lemma),
      ),
    ).toBe(true);
  });
  it("normalizes keys, resolves slash spelling variants, and keeps lowest POS level", () => {
    expect(data.lookupEntry("en:BOOK").level).toBe("A1");
    expect(data.lookupEntry("colour").lemma).toBe(
      data.lookupEntry("color").lemma,
    );
    expect(data.lookupEntry("a.m.").Variants).toContain("am");
  });
  it("returns definitions grouped by POS and no more than two per POS", () => {
    expect(data.lookupEntry("light").GlossTarget).toContain("n.");
    expect(data.lookupEntry("light").GlossTarget).toContain("v.");
    for (const poses of Object.values(packs[2].entries) as Record<
      string,
      string[]
    >[])
      for (const definitions of Object.values(poses))
        expect(definitions.length).toBeLessThanOrEqual(2);
    expect(data.lookupEntry("achieve").Reading).toContain("tʃ");
    expect(data.lookupEntry("achieve").Reading).toContain("ˈ");
  });
  it("marks missing OEWN words as 词典没有 without inventing definitions (T-11)", () => {
    const missing = data.lookupEntry("vokanonexistentlemma");
    expect(missing.dictionaryStatus).toBe("missing");
    expect(missing.message).toBe("词典没有");
    expect(missing.GlossTarget).toBe("");
    // Closed-class words in CEFR remain importable even when OEWN lacks a definition.
    const knownMissing = data.pack.entries.find(
      (e) => data.lookupEntry(e.lemma).dictionaryStatus === "missing",
    );
    expect(knownMissing).toBeDefined();
    expect(data.lookupEntry(knownMissing!.lemma).message).toBe("词典没有");
  });
  it("uses irregular exceptions, suffix candidates, and ADR-0001 ambiguity ordering", () => {
    expect(data.lemmaCandidates("went")).toContain("go");
    expect(data.lemmaCandidates("children")).toContain("child");
    expect(data.lemmaCandidates("dogs")).toContain("dog");
    expect(data.lemmaCandidates("running")).toContain("run");
    const saw = data.lemmaCandidates("saw");
    expect(saw).toContain("see");
    expect(saw).toContain("saw");
    expect(saw[0]).toBe("saw");
  });
  it("preserves required metadata on every pack", () => {
    for (const pack of packs) {
      expect(pack.source.length).toBeGreaterThan(0);
      for (const key of [
        "license",
        "version",
        "generatedDate",
        "dataVersion",
        "attribution",
      ])
        expect(pack[key]).toBeTruthy();
      expect(pack.entryCount).toBeGreaterThan(0);
    }
  });
});
