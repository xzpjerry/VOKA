# Real English data pipeline acceptance (#26)

2026-10-31. Data version `en-2026.10`. Official CEFR-J 1.6 downloaded non-interactively, so no 1.5 fallback was necessary. OEWN latest published release checked against GitHub Releases: 2025-edition. All source URLs and SHA-256 checksums: [`tools/data/sources.json`](../../tools/data/sources.json).

## Build and data

`npm run data:build` succeeds and prints:

| A1 | A2 | B1 | B2 | C1 | C2 | Unique Keys |
|---|---|---|---|---|---|---|
| 1050 | 1200 | 2085 | 2383 | 909 | 868 | 8495 |

The spec's approximate counts use 1.5. This build uses the official 1.6 `ALL` sheet. Source-local deduplication gives A1 1051 / A2 1200 / B1 2085 / B2 2383 / C1 909 / C2 869; runtime canonicalization additionally folds standalone `am` into `a.m.` and `sulphur` into `sulfur`, avoiding duplicate immutable Keys. Both source files remain separate with their own levels, attributions and licenses; cross-file lowest-level and alias rules apply only in memory. Tests check exact counts and unique Keys.

OEWN contains 74,441 normalized single-word lemmas (all single-word entries, including names and hyphens), ≤2 definitions/POS. CMUdict supplies 126,052 first-pronunciation US IPA entries; OEWN supplies 10,261 US-labelled POS-grouped fallback entries. Morphology contains 4,415 irregular form/POS records plus suffix rules. GlossNative is empty everywhere. No ECDICT, Wiktionary or Kaikki data is downloaded or distributed.

| Delivered file | Raw bytes | gzip bytes |
|---|---:|---:|
| cefrj.json | 136873 | 27088 |
| octanove.json | 43256 | 9183 |
| oewn.json | 7591321 | 2313593 |
| readings.json | 3483049 | 839720 |
| oewn-readings.json | 380836 | 112670 |
| morphology.json | 97724 | 23883 |
| attributions.json | 29148 | 8888 |
| sizes.json | 449 | 194 |
| **Total** | **11762656** | **3335219** |

Gzip computed independently per file with `mtime=0`. Packs are committed so ordinary `npm run build` needs no Python/network/upstream availability; about 3.34 MB compressed is below the spec's 5 MB estimate. Complete notices and pack metadata ship with the extension and render in Options' About section. Generation date is fixed to this data release for byte-for-byte reproduction.

## Checks

* Fresh local `git clone --no-local`, empty `.cache/data/`: `npm ci`, `npm run data:build`, `npm run build`, `npm test` all passed; regenerated packs were byte-identical to committed files and `git status --porcelain` stayed empty.
* `npm run build && npm test`: passed after rebase onto gloss/highlighting main, 75 tests including pack metadata, counts, variants, POS definitions, irregular/suffix candidates, missing dictionary marker, and 205-entry request batching.
* `npm run check:anki`: isolated Anki 26.09.3 at **127.0.0.1:8766**, v1 check/read-only lists passed; closed-port unreachable check passed.
* `npm run check:data`: production **B1 preview only**, target `VOKA Vocabulary · English` / `VOKA::English::B1`: **2080 new / 5 existing / 0 conflict / 6410 skipped**, 2085 B1 total. Requests restricted to noteTypes.list/get, decks.list, notes.search/getMany; no writes. Existing five fixture keys explain new count below 2085. Full production B1 import was not executed.
* `npm run check:data:browser`: Chrome 156.0.8078.47, real extension and 8766 read-only. `abandoning` resolves to B1 `abandon` and highlights; `achieved` resolves to A2 `achieve` and does not highlight at B1; `colour` shows canonical `color` with OEWN English definitions. Hover-all on an unknown lemma shows localized `Not in dictionary` (Chinese catalog: `词典没有`). Options has all six pack attributions and complete notices; [About screenshot](data-evidence/about.png) visually inspected.
* `npm run check:highlight`: passed on the real levels (initial target A2, then B1); exclusions, unchanged text/HTML/layout, manual known/unknown, hover scope, advanced inflection, dynamic text/exclusion, disconnect/reconnect and single drawer host. This helper explicitly injects the 12-note fixture for provisioning and restores the two temporary ManualStatus changes.
* T-11: real leveled lemma `'m` and invented `vokanonexistentlemma` return `dictionaryStatus: missing`, `message: 词典没有`, and empty GlossTarget; no fabricated fallback definition. Dictionary API tested directly and missing marker additionally verified in the real hover tooltip.
* `npm run check:import`: explicit **small synthetic fixture**, 12 notes in new throwaway type `VOKA Import Acceptance 1793437275854` and deck `VOKA::Import Acceptance 1793437275854::B1`; repeat import created zero; existing cards, notes and revlog preserved. `col.scm` remained `1793435872969`; no reviews driven. Fixture artifacts retained, no delete calls.

## Limits and unverified items

Full production B1 writing is deliberately unverified. The reading flow merged on main is wired to real data through bounded background batches. Exhaustive dictionary/pronunciation quality is not manually checked; inherited precedence unit tests remain passing. CMUdict has no POS annotations; first unlabelled pronunciation may not match every heteronym sense. IPA conversion is broad phoneme transliteration, not syllabification. US-labelled OEWN fallback is conservative and omits unmarked/GB-only IPA. Native gloss generation remains #28–#30. CEFR-J embedded-use clarification and Octanove provenance confirmation are publication gates under §7.3, not completed by this ticket.

## Follow-up rebase onto drawer #42 and dynamic pages #44

Rebased onto main including the bottom drawer and incremental reading sessions. Preserved drawer filters/counts/settings and the cancelable `voka-open-card` event with scroll/flash fallback. Missing-filter membership and row labels now use the real OEWN `dictionaryStatus`, independent of Anki/user gloss text. Unit coverage verifies a dictionary-present entry with empty gloss stays out of the missing filter and a dictionary-absent entry with user gloss stays in it.

Preserved #44's per-block revision checks, yielded batches, retained Range identity and session-only canonical Anki Key cache. Added real-data resolution before Anki lookup and a session-only surface-form cache, so repeated words do not require repeated dictionary requests. No full dictionary is copied into content scripts.

Validation after this rebase: `npm run build && npm test` passed **79 tests / 8 files**; `npm run check:highlight` and `npm run check:data:browser` passed with Chrome 156 and fixed isolated Anki **8766**. Drawer browser counts were **target 4 / learning 0 / missing 1 / all 10**, with the missing filter showing only `vokanonexistentlemma`; drawer toggle, scroll/flash activation, manual-state count refresh, preference persistence, dynamic exclusion and disconnect/reconnect passed. `npm run check:dynamic` also passed: **2,000 React paragraphs / 8,000 initial ranges**, about **770 ms** initial processing, no initial or scroll long tasks, maximum scroll frame about **18 ms**, and no detached/empty/duplicate ranges. The older browser fixtures now select real **A2** for achieve/improve/encourage/develop instead of their prior synthetic B1 levels. Full production B1 import remains unexecuted; all Anki endpoints were 8766 or the intentional closed-port negative check, never 8765.
