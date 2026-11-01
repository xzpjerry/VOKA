# Reader review acceptance

Re-run with `npm run build && npm test`, `npm run check:epub`, and `npm run check:pdf`. Both browser checks connect only to the isolated Anki test instance on port 8766 and remove `VOKA Test::86` on completion.

## EPUB reader

| Test | Result | Evidence |
| --- | --- | --- |
| Drawer due count, due filter, and Review button | Pass | Four due cards appear in the drawer; Review starts on the first due card. |
| Full-card practice for a future Review card | Pass | The practice view has no rating buttons; `reviews.getLatestId` and `scheduling.get` match their baselines after practice. |
| Again, Hard, Good, and Easy reviews | Pass | `reviews.list` returns exactly one matching record for each of the four cards, and each card's scheduling state changes. |
| Empty queue behavior | Pass | After the four reviews, the visible Review button displays the no-due practice message. |

## PDF reader

| Test | Result | Evidence |
| --- | --- | --- |
| Drawer due count, due filter, and Review button | Pass | Four due cards across pages 1–3 appear in the drawer; Review starts on the first due card. |
| Full-card practice for a future Review card | Pass | The practice view has no rating buttons; review ID and scheduling state remain unchanged. |
| Again, Hard, Good, and Easy reviews | Pass | `reviews.list` returns exactly one matching record for each of the four cards, and each card's scheduling state changes. |
| Empty queue behavior | Pass | After the four reviews, the visible Review button displays the no-due practice message. |
| #106 source page follows the saved token | Pass | Page 2 stays current while saving an example for the word at the top of page 3; the source is `VOKA PDF Test Document · Page 3 · 2026-11-01`. |

## Not verified

Chrome for Testing reports `en-US` in this environment despite the `--lang=zh-CN` launch argument, so the PDF source assertion verifies the localized English `Page 3` label here. The Chinese literal `第 3 页` was not exercised in this browser run.
