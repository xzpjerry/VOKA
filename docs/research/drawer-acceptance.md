# Bottom drawer acceptance (#24)

2026-10-31, Chrome for Testing 156.0.8078.47, isolated AnkiConnect v1 at **127.0.0.1:8766**. Run `npm run build && npm test && npm run check:highlight` (70 unit tests). Browser assertions extend the existing reading fixture check; screenshots are in [drawer-evidence](drawer-evidence/expanded.png).

- Drawer is collapsed initially. Expanded view has connection status, English / B1 read-only display, gloss setting, advanced checkbox, hover scope, four filters and a scrollable list. Due-summary slot is reserved and hidden (P1).
- Fixture counts: target **4**, learning **0**, dictionary missing **2**, all **9**. Targets are achieve (surface achieved), afford (manual unknown), improve and encourage (two occurrences, one row). Missing entries Reading and fixture use surface forms. Advice is manual known; apple is below target; abandoning is advanced.
- Selecting missing shows only en:reading and en:fixture. Clicking achieve after scrolling away scrolls to its first occurrence and adds a temporary CSS highlight. No wrappers or page text changes.
- Real Anki ManualStatus refresh: changing afford to known and reinjecting changes target count 4 → 3; restoring unknown and refreshing returns 4. The test restores both original note values in finally.
- Changing the drawer's showAdvanced and hoverScope controls persists true/all in local storage, adds the advanced highlight, and enables the apple tooltip. Target-level changes, dynamic subtree updates and connection refresh still pass the existing browser check.
- A closed ephemeral port clears highlights, tooltip and list, and shows the not-running summary; restoring 8766 recovers. English browser renders “VOKA is not running: please check Anki”; Chinese catalog retains exactly “VOKA 未运行：请检查 Anki”. [Disconnected evidence](drawer-evidence/disconnected.png).
- Unit coverage adds document-order/Key deduplication (achieved + achieve), missing surface preservation, learning filter membership, manual unknown target membership and independent missing-dictionary membership.

## Integration and limits

List navigation dispatches a cancelable `document` CustomEvent `voka-open-card` with `detail: { token }` after scrolling. A card listener calls preventDefault() to claim it; otherwise navigation flashes the Range for 900 ms. Coordinator relayed this contract to #22. Full card opening is not verified because #22 is not on main at this implementation point.

Gloss selector writes the existing flat glossLanguage key; #25's existing background listener performs the marker-only CSS switch. This drawer run does not separately revalidate Anki CSS or col.scm (covered by #25's acceptance). Learning filter has unit coverage but no scheduling mutation was performed to manufacture a real learning card. Real data #26 is not on main; this run uses the existing synthetic reading pack, not production dictionary coverage. Chinese browser locale, other browsers, mobile, and due counts were not tested.
