import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createData, LEVELS } from "./index";
const names = [
  "cefrj",
  "octanove",
  "oewn",
  "readings",
  "oewn-readings",
  "morphology",
  "gloss-zh",
  "gloss-leveled",
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
    expect(data.pack.entries.every((e) => !/[\s_]/.test(e.lemma))).toBe(true);
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
  it("loads versioned native glosses and returns them grouped by POS", () => {
    const native = packs[6];
    expect(native.models).toContain("deepseek/deepseek-flash");
    expect(native.sourceLemmaCount).toBe(74441);
    expect(native.promptSha256).toBe(
      createHash("sha256")
        .update(readFileSync("tools/gloss/prompt.txt"))
        .digest("hex"),
    );
    expect(native.entryCount).toBe(Object.keys(native.entries).length);
    expect(native.missingCount).toBe(native.missingLemmas.length);
    expect(native.entryCount + native.missingCount).toBe(
      native.sourceLemmaCount,
    );
    expect(native.complete).toBe(native.missingCount === 0);
    expect(
      native.missingLemmas.every((lemma: string) => !native.entries[lemma]),
    ).toBe(true);
    expect(data.lookupEntry("abandon").GlossNative).toContain("v.");
    expect(data.lookupEntry("abandon").GlossNative).toMatch(/[\u4e00-\u9fff]/);
    expect(data.lookupEntry("colour").GlossNative).not.toBe("");
    const found = data.pack.entries.filter(
      (entry) => data.lookupEntry(entry.lemma).dictionaryStatus === "found",
    );
    expect(found.length).toBeGreaterThan(0);
    expect(found.some((entry) => entry.GlossNative !== "")).toBe(true);
    for (const [lemma, poses] of Object.entries(native.entries) as [
      string,
      Record<string, string[]>,
    ][]) {
      expect(Object.keys(poses).sort()).toEqual(
        [
          ...new Set(
            Object.keys(packs[2].entries[lemma]).map(
              (pos) => pos.split("-")[0],
            ),
          ),
        ].sort(),
      );
      expect(Object.keys(poses).length).toBeGreaterThan(0);
      for (const senses of Object.values(poses)) {
        expect(senses.length).toBeGreaterThanOrEqual(1);
        expect(senses.length).toBeLessThanOrEqual(3);
        expect(new Set(senses).size).toBe(senses.length);
        for (const sense of senses)
          expect(sense).toMatch(
            /^[\u3400-\u4dbf\u4e00-\u9fff\u{20000}-\u{323af}]{1,10}$/u,
          );
      }
    }
  });
  it("merges synthetic native glosses across spelling variants and caps at three", () => {
    const synthetic = createData([
      ...packs.slice(0, 6),
      {
        entries: {
          color: { n: ["颜色", "色彩", "肤色"], v: ["着色"] },
          colour: { n: ["颜色", "彩色"] },
        },
      },
    ]);
    expect(synthetic.lookupEntry("colour").GlossNative).toBe(
      "n. 颜色; 色彩; 肤色 · v. 着色",
    );
  });
  it("marks missing OEWN words as 词典没有 without inventing definitions (T-11)", () => {
    const missing = data.lookupEntry("vokanonexistentlemma");
    expect(missing.dictionaryStatus).toBe("missing");
    expect(missing.message).toBe("词典没有");
    expect(missing.GlossTarget).toBe("");
    expect(missing.GlossNative).toBe("");
    expect(data.pack.entries.every((e) => e.GlossNative && e.GlossTarget)).toBe(
      true,
    );
    expect(data.lookupEntry("and").dictionaryStatus).toBe("found");
  });
  it("filters leveled senses to source POS and supplies bilingual closed classes", () => {
    for (const word of [
      "a",
      "it",
      "he",
      "or",
      "as",
      "at",
      "can",
      "and",
      "because",
      "could",
      "myself",
      "to",
      "was",
    ]) {
      const entry = data.lookupEntry(word);
      expect(entry.GlossNative, word).toMatch(/[\u4e00-\u9fff]/);
      expect(entry.GlossTarget, word).not.toBe("");
      expect(entry.GlossNative, word).not.toMatch(/氦|砷|砹|信息技术|手术室/);
    }
    expect(data.lookupEntry("goods").GlossNative).not.toMatch(/好处|美德/);
    expect(data.lookupEntry("a").GlossNative).toContain("det.");
    expect(data.lookupEntry("can").GlossNative).toContain("modal");
    expect(data.lookupEntry("may").GlossNative).toContain("n.");
    expect(data.lookupEntry("may").GlossNative).toContain("modal");
    expect(packs[0].entries.it[2]).toContain("n");
    expect(packs[0].caseCollisions.it.headwords.IT).toEqual(["n"]);
    const supplement = packs[7];
    expect(supplement.complete).toBe(true);
    expect(supplement.model).toBe("gpt-6-luna");
    expect(supplement.effort).toBe("max");
    expect(supplement.promptSha256).toBe(
      createHash("sha256")
        .update(readFileSync("tools/gloss/supplement-prompt.txt"))
        .digest("hex"),
    );
    for (const poses of Object.values(supplement.entries) as Record<
      string,
      { native: string[]; target: string[] }
    >[]) {
      for (const group of Object.values(poses)) {
        expect(group.native.length).toBeGreaterThan(0);
        expect(group.native.length).toBeLessThanOrEqual(3);
        expect(group.target.length).toBeGreaterThan(0);
        expect(group.target.length).toBeLessThanOrEqual(3);
        for (const sense of group.native)
          expect(sense).toMatch(
            /^[\u3400-\u4dbf\u4e00-\u9fff\u{20000}-\u{323af}]{1,10}$/u,
          );
      }
    }
    // Unleveled OEWN entries keep all their original senses.
    expect(data.lookupEntry("aardwolf").GlossTarget).toContain("n.");
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
