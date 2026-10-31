# Lemma candidates (#27)

Verified 2026-10-31 with Chrome for Testing 156.0.8078.47 and isolated AnkiConnect on 127.0.0.1:8766. Reproduce with `npm run build && npm test && npx tsx scripts/check-candidates.ts`; machine-readable results are in `lemma-candidates-evidence/result.json`.

The pure `selectCandidate` function chooses the lowest CEFR level, then prefers the normalized surface lemma on ties. Unit tests cover one/zero candidates, canonical spelling, differing levels, level ties, ungraded ties, order independence, and no input mutation. Dynamic-reading coverage checks that the selection updates all existing occurrences, their highlights, and newly inserted occurrences.

Browser checks passed: saw/see candidate buttons switch the card, colour opens color, saving after switching back to saw writes a bold surface occurrence to en:saw and leaves en:see unchanged, manual status writes en:saw and turns its occurrence red, tooltip shows saw, reopening retains the choice, and reloading resets it. The first browser attempt created the absent en:saw note through the manual-status add flow (no example); subsequent successful runs reuse that note and restore its prior fields. No notes are deleted.

## T-28 discrepancy

Production CEFR-J gives both saw and see A1. ADR-0001's explicit surface tie rule therefore selects en:saw, contrary to T-28's en:see example. The coordinator confirmed preserving the data and ADR rule, so the browser asserts saw by default and offers see as the alternative. No contextual disambiguation or data exception was added.

## Limits

The exact T-28 en:see default is deliberately not satisfied pending the maintainer's decision on the contradictory rule. This run did not test AnkiMobile, AnkiDroid, multiple tabs, or cross-origin navigation. Choices are held only in the content script's in-memory map, with no storage writes; a reload creates a new map. Build and all 116 tests pass.
