# Remember kept gloss upgrades (#60)

Maintainer option B is implemented: `chrome.storage.local.upgradeKept` maps note IDs to the preview data version. Only confirmation adds records, for every unchecked preview row. Abandoning a preview records no decisions. Kept rows cause no Anki writes and no sync calls. Preview, drawer summaries, and import-preview counts use the same exclusion.

Decisions apply to the whole data version, including if the user subsequently changes generated fields. A later data version re-prompts and classifies edits against the unchanged Anki hashes. Device changes and extension reinstall can re-prompt. Settings displays the local kept-note count and “重新显示已保留的更新” clears all decisions and refreshes the preview. Scans prune old versions and missing/nonmatching note IDs; failed note reads preserve current-version records conservatively.

Summary requests queue behind confirmation so storage-triggered content refreshes observe the completed decisions rather than losing the drawer refresh to a busy response. Settings also refreshes an already displayed import count when decisions change.

## Validation

- `npm run build && npm test`: 17 test files, 136 tests pass. Tests cover confirmation, preview abandonment/cancel, no Anki writes for all-kept confirmation, same-version exclusion after further edits, older-version reappearance with edited classification, reset, and pruning.
- `npm run check:gloss-upgrade`: Chrome for Testing with isolated **127.0.0.1:8766**. T-29 imports two named fixture notes, edits one, previews both groups, and confirms only the unedited note. The entire kept note including its modification timestamp is byte-for-byte unchanged; every card and unrelated note also remains unchanged. A fresh preview excludes the kept note, drawer notice disappears, and Settings reset brings it back. Latest fixture IDs and evidence are in [result.json](gloss-upgrade-evidence/result.json).
- No sync, deletion, scheduling, card moves, or note-type structure edits are called. Named test fixtures remain in the isolated collection.

Not verified: real device/reinstall migration, AnkiMobile/AnkiDroid, sync transport, live transport interruption/partial failure, or external Anki edits during an in-flight patch. Deterministic tests cover write failures and uncertain responses. The pre-existing lack of an atomic conditional-write API remains unchanged.
