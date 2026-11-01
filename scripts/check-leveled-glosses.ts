/** Offline #64 coverage, format, POS isolation and before/after evidence. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createData, DATA_VERSION, LEVELS } from "../src/data";
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
const packs = names.map((n) =>
  JSON.parse(readFileSync(`public/data/${n}.json`, "utf8")),
);
const data = createData(packs);
// Immutable pre-#64 source packs reconstruct the previous lookup behavior.
const baseline = createData(
  names
    .slice(0, 7)
    .map((n) =>
      JSON.parse(
        execFileSync(
          "git",
          [
            "show",
            `a2d6dc1f1af0db7a2b1bda06b788125877bf70bb:public/data/${n}.json`,
          ],
          { maxBuffer: 32 * 1024 * 1024 },
        ).toString(),
      ),
    ),
);
const supplement = packs[7];
assert.equal(supplement.complete, true);
assert.equal(supplement.dataVersion, DATA_VERSION);
const report = "docs/research/leveled-pos-glosses";
mkdirSync(report, { recursive: true });
const coverage = LEVELS.map((level) => {
  const entries = data.pack.entries.filter((e) => e.level === level);
  const missing = entries.filter((e) => !e.GlossNative || !e.GlossTarget);
  assert.equal(missing.length, 0, `${level}: bilingual coverage`);
  return { level, entries: entries.length, missing: missing.length };
});
const allowedByLemma = new Map<string, Set<string>>();
for (const p of packs.slice(0, 2)) {
  for (const [word, value] of Object.entries(p.entries) as [
    string,
    [string, string[], string[]],
  ][]) {
    const lemma = data.lookupEntry(word).lemma;
    const allowed = allowedByLemma.get(lemma) ?? new Set<string>();
    value[2]
      .filter(
        (pos) => !(p.caseCollisions?.[word]?.suppressedPos ?? []).includes(pos),
      )
      .forEach((pos) => allowed.add(pos));
    allowedByLemma.set(lemma, allowed);
  }
}
for (const [lemma, poses] of Object.entries(supplement.entries) as [
  string,
  Record<string, { native: string[]; target: string[] }>,
][]) {
  const allowed = allowedByLemma.get(lemma)!;
  assert.deepEqual(Object.keys(poses).sort(), [...allowed].sort(), lemma);
  for (const group of Object.values(poses)) {
    for (const senses of [group.native, group.target]) {
      assert(senses.length >= 1 && senses.length <= 3);
      assert.equal(new Set(senses).size, senses.length);
    }
    group.native.forEach((s) =>
      assert.match(
        s,
        /^[\u3400-\u4dbf\u4e00-\u9fff\u{20000}-\u{323af}]{1,10}$/u,
      ),
    );
  }
}
const collisions = Object.fromEntries(
  packs.slice(0, 2).flatMap((p) => Object.entries(p.caseCollisions ?? {})),
);
writeFileSync(
  `${report}/case-collisions.json`,
  JSON.stringify(collisions, null, 2) + "\n",
);
const words = [
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
];
const rows = words.map((word) => ({
  word,
  before: baseline.lookupEntry(word),
  after: data.lookupEntry(word),
}));
const escape = (s: string) => s.replaceAll("|", "\\|").replaceAll("\n", " ");
const lines = [
  "# Leveled POS gloss acceptance (#64)",
  "",
  `Data version: ${DATA_VERSION}. All ${data.pack.entries.length} leveled lemmas have both gloss languages; missing 0.`,
  "",
  "| Level | Lemmas | Missing bilingual gloss |",
  "|---|---:|---:|",
  ...coverage.map((c) => `| ${c.level} | ${c.entries} | ${c.missing} |`),
  "",
  "## Common-word before/after",
  "",
  "| Word | Previous Chinese | Current Chinese | Previous English | Current English |",
  "|---|---|---|---|---|",
  ...rows.map(
    (r) =>
      `| ${[r.word, r.before.GlossNative, r.after.GlossNative, r.before.GlossTarget, r.after.GlossTarget].map(escape).join(" | ")} |`,
  ),
  "",
  "## Generation and reuse",
  "",
  "The original 74,441-entry pack and pilot prompt are unchanged. The source level POS union filters both languages; aliases fold to one Key and unleveled OEWN entries keep their existing behavior. The supplement stores filtered bilingual reuse plus 453 generated lemmas covering 520 missing POS pairs, generated through Codex gpt-6-luna effort max with a separate prompt and per-batch request hashes. See progress.json for actual validated/retry counts, reuse.json for every nonidentity source mapping, and spot-check.csv for 20 sampled lemmas per level (all POS rows shown; closed classes prioritized where present).",
  "",
  "The coordinator-approved case rule suppresses POS found only on an ALL-UPPERCASE acronym (length >= 2) when it shares a Key with a lowercase source headword, retaining the raw POS and headwords in source metadata. Title-case collisions such as May/may remain merged. Every affected Key: en:it (IT=n, it=pron; n suppressed). See case-collisions.json.\n\nPinned Octanove errata: batter has blank POS but source note 'one who bats', mapped to n; remonstrate has POS 'vern', corrected to v. The lexical plural goods is generated separately: reusing good would incorrectly produce benefit/virtue rather than merchandise. Source packs retain independent licenses and model/prompt attribution is included in the About metadata.",
  "",
  "## Validation",
  "",
  "Offline coverage and exact source-POS matching passed for every leveled lemma; all supplement Chinese senses satisfy 1–10 Han characters and all bilingual groups contain 1–3 distinct senses. Semantic sampling is review evidence, not a claim of human approval of every generated meaning.",
  "",
];
writeFileSync(`${report}/report.md`, lines.join("\n"));
writeFileSync(
  `${report}/coverage.json`,
  JSON.stringify({ version: DATA_VERSION, coverage }, null, 2) + "\n",
);
console.log("PASS #64 bilingual coverage and source POS", coverage);
