# Full cards and real context sentences — issue #22

Verified 2026-10-31 using Chrome for Testing 156.0.8078.47 and the isolated AnkiConnect v1 instance at **127.0.0.1:8766**. No requests were sent to 8765. The final implementation is rebased onto the real-data pipeline (#43), drawer (#42), and block-level dynamic reading (#44), and onboarding/settings (#45).

## Reproduce

```sh
npm ci
npm run build && npm test
npm run check:contexts
npm run check:highlight
```

Build passes; all **100 tests across 11 files** pass. The new pure tests cover sentence segmentation/windowing, actual-surface bolding, HTML escaping, normalization, dedupe, slot ordering, single-pin behavior, stale pins, and replacement selection. DOM tests cover inline markup, punctuation-free list items/headings/table cells and excluded editable regions. Gateway tests cover fresh merges, changed-fields-only updates, stale replacement hashes, conflicting Keys, unknown write outcome readback without retry, A2 adds, and unlevelled adds.

## T-10: four pages and an Anki edit

The script serves four distinct local URLs with four sentences containing `apple`. It opens the full Shadow DOM card using actual double clicks and saves three sentences. The fourth card shows **替换一条…**, lists all three, and preselects the oldest unpinned sentence. Choosing a different row and confirming retains exactly three Context/Source pairs.

Before the second save, the script pins the first sentence, then uses real `notes.update` to change its text directly in Anki. Subsequent saves preserve that edit; because its original content hash is no longer present, the stale pin is cleared. The fourth-page replacement deliberately chooses another row and asserts that the Anki edit still exists.

- [Fourth-page chooser](context-evidence/replacement.png): the edited sentence is visible and selected by default as the oldest unpinned sentence.
- [Fourth-page save](context-evidence/saved.png): three retained sentences, including the Anki edit.
- [Final production-data run](context-evidence/result.json): browser, real data version, replacement selection, fields and checks.
- [First production-data creation run](context-evidence/production-first-run.json): records `createdManual: true` for `en:banana` at A1.

Later long/footnote cases deliberately use the default replacement and can evict the older edit; the preservation assertions and fourth-page screenshot occur before those explicit replacements. Existing `apple` fields are backed up and restored in `finally`; newly created test notes remain for inspection.

## T-32 and interaction boundaries

The browser check saves a >300-character sentence and verifies a centered window with `…` and `<b>apple</b>`. It refuses a two-word sentence, strips `[1]` and `¹`, saves the cleaned sentence, and verifies that the same sentence from another URL is rejected as a duplicate.

- [Short sentence refusal](context-evidence/short.png)
- [Duplicate refusal](context-evidence/duplicate.png)

The check also proves that one click on an unhighlighted `apple` opens nothing; a link still changes the page hash; a button still runs its handler; one click on the highlighted B1 word `benefit` opens its card; and double clicking an unknown word displays **词典没有**. No page click/double-click event is canceled. `check:highlight` also verifies that drawer word activation opens the card, followed by the existing highlight, preference, dynamic-update, disconnect and reconnect checks.

## Manual add and sources

With target level B1, the final first production-data run creates only **`en:banana` (A1)**, in **`VOKA::English::A1`**, with `voka` / `voka::level::A1` tags. The A1 note count increases by exactly one, demonstrating no whole-level import. The note includes the encountered sentence, source, real reading/gloss, data version and generated-field hashes. Repeat runs recognize the retained fixture and skip creating it again.

Earlier, before #43 landed, the same flow created synthetic `travel` in A2; [first-run.json](context-evidence/first-run.json) retains that historical result. The production results are authoritative for current levels (`apple` and `banana` are A1 in the real dataset). Existing synthetic notes are not migrated or moved.

The default source is domain, title and date; the real browser check verifies that the URL/path is absent. The flat setting `storeFullUrl` defaults to false and is exposed in Options. The live browser check toggles that Options checkbox and verifies persistence in both directions; full-URL source construction is unit tested.

## Remaining limits

- Multi-candidate switching (#27) and manual-status controls (#23) are intentionally empty `data-slot` hooks. The card claims the cancelable `voka-open-card` event used by the drawer.
- The production data currently provides target-language glosses; native-language glosses fall back according to the existing settings, and existing note glosses are retained.
- Unlevelled deck creation, full-URL opt-in, pinned replacement refusal and unknown transport outcomes have unit coverage; those branches were not all driven through the live browser/Anki run.
- Mobile clients, AnkiWeb sync, concurrent human edits during the small read/write interval, and arbitrary third-party page layouts were not tested. The v1 API has no conditional field-update primitive; every save reads current fields and merges immediately, but cannot make an external editor's simultaneous write atomic.
