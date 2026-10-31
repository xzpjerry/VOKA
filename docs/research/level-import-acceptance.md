# Whole-level import acceptance (#32)

2026-10-31, Anki 26.09.3, AnkiConnect v1, isolated `127.0.0.1:8766/api/v1` only. No sync, scheduling mutation, card move, structure edit or delete method was called by product code. The full 2,085-word B1 pack was imported through the real Options UI against throwaway note types and decks selected by the test-only `testImportTarget` storage key. Test-owned notes, decks and note types were then removed by `npm run cleanup:level-import`; product code contains no delete path.

- `npm run build && npm test`: passed; 12 test files, 112 tests. Import coverage includes Key normalization, exact UTF-8 hashes/VokaMeta, read-only previews, conflict listing, A2 filtering, duplicate fixture Keys, pagination/exact Key comparison, field-structure refusal, valid-only submission, unresolved-write read-back without resend, 200-note logical batches (100-note v1 wire batches), progress phases, cancel/resume, interrupted resume, and a no-forbidden-method assertion.
- `npm run check:level-import`: passed end-to-end in **62.4 s** including browser startup, all UI checks, the interrupted run, resume, T-06 and read-only SQLite snapshots.

## Results

| Check | Result |
|---|---|
| T-03 preview | Data pack 8,495 words; selected B1 2,085 words. **New 2,085 / existing 0 / conflict 0 / skipped 6,410 (other levels)**. Target deck and note type both **新建**. The page showed 「不会修改、移动或重置任何已有卡片」, 「新卡由 Anki 按你的每日新卡上限逐步引入」, the data source and `en-2026.10`. |
| T-03 execution | **9,826 ms** to create 2,085 notes and 2,085 cards. Verified every note carries `voka` and `voka::level::B1`, and all cards are in the throwaway B1 deck. The progress bar was observed in flight (121 non-terminal samples). |
| T-04 repeat | Second preview **new 0 / existing 2,085**, Confirm disabled. A direct second execution took **2,800 ms**, created 0, called no `notes.validateMany`, `notes.createMany`, `decks.create` or `noteTypes.create`, and every note/card payload was byte-identical. |
| T-07 level switch | B1 → B2 → B1 updated `targetLevel` and the import selector, showed the no-delete/no-move/no-reset hint for B2, and offered its import. All 2,085 B1 notes and cards were byte-identical before and after. Highlight rendering itself is covered by the highlight tickets. |
| T-06 manual A2 word | Added `en:ability` manually through the normal card-context save path into `VOKA::English::A2`. A2 preview moved from **new 1,192 / existing 8** to **new 1,191 / existing 9**; the row for that Key became `existing` and exactly one note matched it. |
| Interruption | Switched the live gateway to a just-closed local port after batch 1. The first run stopped in **857 ms** with **200 created, 400 processed, 200 pre-validation failures**; batch 2 was never written. All 200 partial notes/cards were unchanged. |
| Resume | After restoring port 8766, preview was **new 1,885 / existing 200**. Resume took **7,275 ms**, created exactly 1,885, and the final preview was **new 0 / existing 2,085**. No duplicate Keys were found. |
| Cancel (real UI) | Cancelled A1 after the first batch: **400 written and kept** in **2,530 ms**. The summary offered 「继续导入（剩余 650 条）」. Resuming took **4,618 ms**, finished at 1,050 notes, with one note per Key. |
| Database integrity | SQLite snapshot via `scripts/anki-snapshot.py`: `col.scm` stayed **1793443040166 → 1793443040166** and the 9 pre-existing revlog rows were unchanged. |
| Cleanup | Removed exactly **5,221 test notes** (2,085 + 2,085 + 1,050 + 1 manual), 6 test decks and 3 test note types. Product note type returned to its prior 22 notes (2 in A2); no `VOKA::Level Import Acceptance` deck or note type remains. |

## Timings

| Step | Time |
|---|---|
| Full acceptance run | 62.4 s |
| 2,085-note import | 9.8 s |
| Repeat import with zero writes | 2.8 s |
| Cancel after first 200-note batch | 2.5 s |
| Resume remaining 650 | 4.6 s |
| Interrupted first run | 0.86 s |
| Resume remaining 1,885 | 7.3 s |

## Evidence

- [`results.json`](level-import-evidence/results.json) — machine-readable counts, timings and database snapshot values.
- [`artifacts.json`](level-import-evidence/artifacts.json) — throwaway names, the one manual A2 note ID, and the cleanup timestamp.
- [`preview.png`](level-import-evidence/preview.png), [`progress.png`](level-import-evidence/progress.png), [`done.png`](level-import-evidence/done.png), [`cancelled.png`](level-import-evidence/cancelled.png), [`resumed.png`](level-import-evidence/resumed.png), [`level-b2.png`](level-import-evidence/level-b2.png).

## Not verified

- A real duplicate-Key conflict in the Anki collection: conflict detection, listing and skipping are covered by the in-memory gateway/fixture tests, not by a deliberately corrupted real collection.
- Cancelling inside an in-flight `notes.createMany` request: cancellation is checked between logical batches, so the verified behaviour is the documented "finish the current batch, keep what was written" boundary.
- Killing the Anki process itself: interruption was simulated by switching to a closed port, as requested for this acceptance.
- Anki's actual daily new-card limit and scheduling: the import creates notes/cards and relies on Anki's deck options; no scheduling API is called or asserted.
- Highlight DOM after switching B1 → B2 → B1: the settings state and card immutability were verified here; highlight visual behaviour is covered by the highlight/gloss tickets.
- Other Anki or AnkiConnect versions, AnkiMobile/AnkiWeb, and very large personal collections.

## Reproduce

```sh
~/VOKA-anki-test/launch.sh
npm run build && npm test
npm run check:level-import
npm run cleanup:level-import   # only test-owned artifacts listed in artifacts.json
```
