# Dynamic paragraph acceptance (#34)

Verified 2026-10-31 with Chrome for Testing **156.0.8078.47**, Puppeteer and the isolated AnkiConnect v1 instance at **127.0.0.1:8766**. No request targets 8765.

## Implementation

`DynamicReading` owns a serial paragraph/block queue, with a fixed 100 ms mutation throttle. Child-list changes discover added subtrees, character changes invalidate the owning block, and visibility/editability changes invalidate affected blocks. Each text node belongs to exactly one nearest paragraph/list item/heading/cell/container block, avoiding duplicate nested extraction. Removed blocks and invalidated ranges are removed from the existing Highlight sets immediately; only changed blocks get new ranges. Revision checks discard stale in-flight results, and initial extraction also accepts mutations arriving while Anki lookups are in flight.

Work yields between batches of at most 32 blocks or approximately 8 ms of extraction (a single block is indivisible). Existing Highlight objects are updated in place. The drawer receives the current token list after the queue drains, including after removals; this was integrated with the newly merged #42 drawer during rebase. Hover checks only the pointer's block instead of measuring every token in the page. New unique Keys are batched through the existing bounded gateway query; both found and absent Keys are cached in memory for the reading session. Explicit toolbar refresh, settings changes, retry and connection loss discard the cache. Nothing is persisted, and dynamic updates alone do not refresh existing Anki state.

## Reproduction and results

Start `~/VOKA-anki-test/launch.sh` if needed, then run:

```sh
npm ci
npx puppeteer browsers install chrome
npm run build && npm test
npm run check:anki
npm run check:highlight
npm run check:dynamic
```

`check:dynamic` downloads the pinned React **18.3.1** production UMD builds from unpkg and serves them with a local fixture. It uses a disposable Chrome profile, sets 8766 before injection, and performs only product read operations against Anki. The pre-existing synthetic B1 notes must exist (the preceding `check:highlight` ensures them using the existing import flow; that check temporarily changes and restores two ManualStatus fields).

- **T-09:** React renders 2,000 paragraphs containing four B1 words each. All **8,000** ranges appear, with exactly unchanged paragraph HTML and main-element geometry. React appends a paragraph (+2 ranges), replaces the first paragraph (−2 net), and removes the replacement (−2). Final count is **7,998**, with no detached or empty ranges. An unaffected paragraph retains its original Range identity. Rechecking after 400 ms leaves content/layout stable.
- Long-page initial processing: **652.9 ms** wall time from extension injection to all 8,000 ranges, including settings, connection check and Anki queries. **Zero ≥50 ms long tasks** were recorded during initialization.
- Scroll: **180 animation frames**, moving 350 px per frame over roughly three seconds; **zero long tasks**, **zero frame intervals over 50 ms**, maximum frame interval **17.7 ms**. The PerformanceObserver runs in the page and records renderer main-thread long tasks, including extension work.
- With these results, off-screen lazy processing was unnecessary for this fixture; all paragraphs are processed in yielded batches. This keeps highlights available when jumping to any page location.
- `npm run build && npm test`: succeeds, **72 tests / 7 files**. Added tests cover unchanged Range identity, caching absent Keys, replacement, removal, emptied paragraphs, ancestor visibility exclusion and mutations during an in-flight lookup.
- `npm run check:anki`: 8766 reports `ok`; deck/type reads succeed; a closed ephemeral port reports `unreachable`.
- `npm run check:highlight`: previous real-browser acceptance passes, including exclusions, tooltip, settings, disconnect/reconnect and repeated injection.

Machine-readable measurements: [dynamic-performance.json](dynamic-performance.json). Results describe one local run, not a cross-device performance guarantee.

## Not verified

Production dictionary coverage (#26 remains unmerged at verification), real third-party React/Vue applications, Vue specifically, iframe/Shadow DOM text, low-end devices, arbitrarily huge individual paragraphs, stylesheet changes without observed DOM mutations, and simultaneous framework updates during the scroll benchmark. Scroll was programmatic requestAnimationFrame scrolling, not a physical wheel/trackpad gesture. No new Anki reviews, scheduling writes, syncs or schema changes were performed. A cache-only DOM update does not detect a newly disconnected Anki instance; detection remains gateway work or explicit/settings refresh, without polling.
