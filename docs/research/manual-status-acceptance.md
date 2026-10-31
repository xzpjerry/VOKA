# Manual status button acceptance (#23)

Verified 2026-10-31 against isolated Anki 26.09.3 / AnkiConnect v1 at **127.0.0.1:8766**, using Chrome for Testing 156.0.8078.47 and Puppeteer. No calls target 8765. Product code only patches `ManualStatus`; it does not touch scheduling, deck placement, note-type structure, or delete data.

Reproduce after starting `~/VOKA-anki-test/launch.sh`:

```sh
npm ci
npx puppeteer browsers install chrome
npm run build && npm test
npm run check:anki
npm run check:manual
```

The full card's single button is chosen from the current state: a highlighted word shows **「我认识，别再高亮」** (`known`), an unhighlighted word shows **「我不认识，高亮它」** (`unknown`), and an already marked word shows **「撤销标记」** (empty). There is no manual “learning” option. The action is written with a fresh Key lookup, a patch containing only `ManualStatus`, and a readback; the page then reapplies highlight rule 1 to existing Ranges and refreshes drawer counts immediately. For a word with no Anki note, the unknown action reuses the existing manual-add flow (`notes.validateMany` → `notes.createMany` → readback) and stores `ManualStatus=unknown` in the same confirmed create.

Passed evidence:

- `npm run build && npm test`: build succeeds; **107 tests across 12 files pass**. New unit tests cover button labels/statuses, rejecting invalid manual values, patching only `ManualStatus` on existing notes, undo, creating a missing note with `ManualStatus=unknown`, and reapplying manual precedence to existing Ranges without a rescan.
- Real browser check with target B1 and the existing A1 `banana` / B1 `benefit` fixture notes:
  - Marking `benefit` known removed its yellow range and lowered the drawer target count by 1; the card changed to 「撤销标记」. Reloading and reinjecting kept it unhighlighted.
  - Marking `banana` unknown produced a red `voka-unknown` range and raised the drawer target count by 1; it stayed red after reload.
  - Undo restored `benefit`'s target highlight and left `banana` unhighlighted (its automatic A1-below-B1 rule), with drawer counts restored.
  - Before/after note fields for both notes differed **only** in `ManualStatus` (see `result.json`).
  - A word with no note (`dog`, A1) was created in `VOKA::English::A1` with the expected level tag and empty contexts, then highlighted red and returned to no highlight after undo.
  - Screenshots: [known](manual-status-evidence/target-known.png), [undo](manual-status-evidence/target-undo.png), [unknown](manual-status-evidence/below-unknown.png), [add-first](manual-status-evidence/absent-added-unknown.png).

Not verified: actual toolbar-icon clicks (the same `chrome.scripting.executeScript` path is driven programmatically); conflict handling for duplicate Keys is covered by existing unit tests, not a duplicate-note fixture; more than one browser window; very large pages; and Anki behavior with real production notes rather than the small fixture notes. The add-first check leaves the created note (with empty `ManualStatus`) in the isolated test collection; fixture ManualStatus values are restored in `finally`.
