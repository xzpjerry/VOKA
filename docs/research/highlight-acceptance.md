# Reading highlights and one-line tooltip acceptance (#21)

Verified 2026-10-31 against isolated Anki 26.09.3 / AnkiConnect v1 at **127.0.0.1:8766**, using Chrome for Testing 156.0.8078.47 and Puppeteer. No calls target 8765. Product code reads scheduling only; it does not change scheduling, move cards, edit note-type structure, delete data, or sync.

Reproduce after starting `~/VOKA-anki-test/launch.sh`:

```sh
npm ci
npx puppeteer browsers install chrome
npm run build && npm test
npm run check:anki
npx tsx scripts/check-highlight.ts
```

The browser check creates a disposable browser profile, sets port 8766 **before** any connection checks, serves [a local HTML fixture](../../scripts/highlight-fixture.html), and injects the built script through the service worker using the same `chrome.scripting.executeScript` path as the toolbar handler. It uses the existing import flow to ensure the B1 fixture notes exist, temporarily sets advice to `ManualStatus=known` and afford to `unknown` with `notes.update`, and restores both original fields in `finally`. New imports, if needed, remain in the isolated test collection. No review/scheduling mutations are made.

Passed evidence:

- `npm run build && npm test`: build succeeds; **68 tests across 5 files pass** (after rebasing onto the merged gloss-language work). Rules cover manual precedence, learning/relearning, Review 20 versus 21 days, New, absent, suspended/buried, lower/target/higher levels, and missing levels. Extraction and hit tests cover excluded ancestors, hidden styles, multiline rectangles, boundary coordinates, detached nodes, and hover scope. Batch-query tests cover deduplication, pagination, exact Key readback, conflicts, and partial failures.
- `npm run check:anki`: 8766 is `ok`, reads decks/types; an allocated closed port is `unreachable`.
- Initial real browser registry: `voka-target` contains `achieved`, `improve`, and two `encourage` ranges; `voka-unknown` contains `afford`; learning/weak sets are empty. `advice` (manual known), `apple` (A2), and `abandoning` (B2, advanced disabled) are absent.
- **T-30**: only the ordinary `achieved` occurrence is highlighted; input/password/textarea, contenteditable, pre/code/kbd/samp, nav/footer/navigation role, hidden/aria-hidden/display:none occurrences are absent.
- Hovering `achieved` shows `achieve` with the existing Anki note's authored gloss in a one-line Shadow DOM tooltip. Hovering unhighlighted advice/apple hides it by default; `hoverScope=all` permits the recognized A2 apple. Native/target fallback and English native-language behavior also have unit coverage.
- `showAdvanced=true` produces one weak range for `abandoning → abandon`. With target B2, it becomes a target range even though this reading-only fixture is not imported by the B1 import flow.
- Page text, original HTML, and the measured paragraph rectangle are identical before/after highlighting. No token wrapper spans are inserted.
- A dynamically added `develop achieved` paragraph is processed; changing it to contenteditable removes its ranges. Existing unaffected text ranges are retained during subtree extraction.
- Switching the stored port to an allocated closed port triggers a connection refresh: **all four VOKA registry entries and the visible tooltip disappear**, and the drawer reads **“VOKA is not running: please check Anki”**. Returning to 8766 restores highlights. Repeated injection retains exactly one drawer host.

Screenshots: [connected with tooltip](highlight-evidence/connected.png), [disconnected](highlight-evidence/disconnected.png).

Not verified: actual Anki UI reviews into Learning/Relearning or the 21-day Review boundary (pure rule tests cover those states); physically quitting Anki (closed-port failure exercises unreachable transport instead); clicking the Chrome toolbar itself (the same injection path was driven programmatically); production wordlists/lemmatization or ambiguous-candidate choice (#26/#27); very large pages, iframe/shadow-root contents, mobile browsers, or long-running performance. This implementation uses the authored synthetic test pack, a reading-only B2 fixture, exact normalized matches, and a deliberately tiny inflection table; it is not production dictionary coverage. No connection polling is added: disconnect detection occurs on gateway work or explicit/settings refresh.
