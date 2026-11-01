# Full native-gloss acceptance (#30)

The committed `en-2026.10.1` pack covers **74,441 / 74,441** OEWN single-word lemmas, with **0 missing** and **100% format compliance** after one retry round. All 27 initial format failures passed that retry. The pilot prompt and mechanical validator are unchanged. The pack is 3,007,109 bytes raw / 969,513 bytes gzip; source and attribution remain separate from OEWN.

| Model / effort | Initial batches | Retry batches | Valid lemmas |
|---|---:|---:|---:|
| Official `deepseek/deepseek-flash` | 342 | 0 | 34,199 |
| `gpt-6-luna`, effort `max` | 403 | 1 | 40,242 |

The coordinator authorized Luna max continuation after the DeepSeek balance was exhausted. Every original DeepSeek batch was retained; model and effort are recorded per new cached batch and summarized in pack/About metadata. No raw cache or provider configuration is committed.

The resumed four-worker run took **5,319.912 seconds (88m 40s)**, including the retry. The earlier DeepSeek cache spans 2,042.925 seconds (34m 03s); summed model spans are about **2h 03m**, with pauses between runs excluded. See [run evidence](run-evidence.json), [generation report](generation-report.md), [per-round statistics](stats.json), [exact failure list](failures.json), and the seeded [210-row human-review sample](spot-check.csv): 30 generated entries per CEFR level plus 30 unleveled entries.

## Verification

- Rebased onto `origin/main` through `ceca397`, preserving lemma-candidate selection and site-scope/cold-start behavior. The package-script conflict retained both `check:scope` and `check:gloss-data`.
- `npm run build && npm test`: passed; **130 tests / 16 files**, including whole-pack Han/sense/POS validation, source coverage and prompt-hash checks.
- `python3 -m unittest discover -s tools/gloss -p 'test_*.py'`: passed; **11 tests**, including effort forwarding, cross-model cache reuse, stale-cache filtering and retry provenance.
- `npm run check:gloss-data`: passed against **127.0.0.1:8766**. Twelve real-pack B1 entries were imported into a new throwaway type/deck. Readback checked GlossNative, GlossTarget, tags, all 15 fields, data version and VokaMeta SHA-256 hashes. Real card HTML was rendered in Chrome; computed language visibility and both missing-field CSS fallbacks passed. Repeat import wrote nothing and preserved all imported note fields. [Raw evidence](import-acceptance.json).
- `npm run check:data:browser`: passed in Chrome 156. The unimported OEWN word `zymurgy` showed English in target mode and Chinese in native mode; the pre-existing `abandon` note has an empty GlossTarget, and its target-mode fallback correctly displayed its existing Chinese gloss. Missing-word text and About attribution passed. The scratch extension seeds port 8766 before onboarding starts, and its Chrome network log asserted **no requests to 8765**. [Browser output](browser-acceptance.txt) and [About screenshot](../data-evidence/about.png).

Existing Anki notes were not upgraded or edited. Browser preference changes may update the existing note type's VOKA CSS marker; direct import checks only created new throwaway targets. No scheduling, sync, card-move, structure-edit or delete methods were called.

## Not verified

Full-corpus semantic quality and the final 210-row sample still require human review. AnkiMobile, AnkiWeb, AnkiDroid and real sync were not tested. Existing-note data upgrade remains #35. An earlier inherited browser-helper run seeded the test port after startup and had no startup network trace; that race was fixed, and the final browser run explicitly verified no 8765 requests.
