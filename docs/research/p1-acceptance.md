# P1 acceptance (T-12–T-18)

Run date: 2026-11-01. The automated checks used only the isolated Anki instance at `127.0.0.1:8766`, a local synthetic fixture page, and a fresh `VOKA Test::P1` deck. Every created note and the test deck were deleted at the end (`CLEANUP OK`).

## Results

| Test | What was done | Expected result | Actual result | Result |
|---|---|---|---|---|
| T-12 | Loaded a page with three due Review cards, two New cards, one Review card due in ten days, and one suspended card that would otherwise be due; checked marks and the due filter. | Only the three due cards appear in the due list; New, future, and suspended cards are excluded. | Due filter count was 3 (`abandon`, `abnormal`, `aboard`). Only `abandon` and `abnormal` were underlined because the known word remains unmarked. New, future, and suspended cards were excluded; the suspended card was confirmed not due. | PASS |
| T-12a | Made one due Review card mature (interval 37 days) and set another due word to `ManualStatus=known`. | Mature card has only the due underline; known word stays hidden while still counting as due. | The 37-day card was underlined without a color highlight. The known word had no page highlight but remained in the due count and list. | PASS |
| T-13 | Opened a due card, inspected the front, then revealed its answer. | Front shows the rendered question and page sentence without either gloss; gloss appears after reveal. | Front showed the rendered question and bold local sentence, with no answer or rating buttons. Revealing the answer exposed both synthetic glosses and all four predicted ratings with their interval labels. | PASS |
| T-14 | Rated the three due Review cards and one due Learning card through the review UI as Again, Hard, Good, and Easy. Checked each review history entry and scheduling state. | Four matching review records are added and each card's scheduling state changes. | `abandon`: Again, Review → relearning; `able`: Hard, Learning → Learning; `abnormal`: Good, Review interval 37 → 100 days; `aboard`: Easy, Review interval 3 → 9 days. Each card had exactly one matching review record and a changed state. | PASS |
| T-15 | Opened a future Review card in VOKA, graded it directly through Anki's API before submitting in the page, then clicked the page's rating. | VOKA reports it was already completed and skips a duplicate review. | The page showed “Already completed in Anki; skipping”; review history contained one new Good record only. | PASS |
| T-16 | Submitted through the timeout-after-forward wrapper, which accepts the answer then simulates a lost response. | The answer is confirmed through review history without forwarding `scheduling.answer` twice. | `submitReview` returned `confirmed`; the wrapper forwarded `scheduling.answer` once and `reviews.list` found exactly one Easy record. | PASS |
| T-17 | Practiced two New cards and one Review card due in the future through front → Show answer → Next. Compared scheduling and review history before and after. | No rating buttons; no review-history or scheduling changes. | All three practice flows had zero rating buttons; `reviews.getLatestId` and `scheduling.get` were unchanged. | PASS |
| T-18 | Made the mature card due, graded it Good in VOKA, then clicked Return to list and checked the due and all filters. | Due underline disappears, due count drops to zero, and list filters recalculate. | Rating succeeded: underline disappeared, due summary went from 1 to 0, and Anki reported the card was no longer due. After Return to list, the review panel hid but the due/all filter controls did not return within 30 seconds, so list counts could not be verified. | FAIL |

## Overdue-card finding

The run graduated a test card to Review, answered it once to create review history, then used `api.describe` to inspect `scheduling.setDueDate`. The method describes Anki's native days/range syntax and the `days` field is a string. Both documented negative forms tried were rejected, so no overdue card was confirmed:

| `days` | Result |
|---|---|
| `-1` | AnkiConnect error `-32603`: `Internal API error.` (`data.type=internalError`) |
| `-2--1` | AnkiConnect error `-32603`: `Internal API error.` (`data.type=internalError`) |

The card was reset to ten days and the run continued. A real overdue state is **not verified**; it was not simulated or inferred from a failed write.

## Failed item: T-18

On `127.0.0.1:8766`, make the mature Review fixture card due, open it from the due summary, reveal the answer, and grade it Good. The due underline disappears and the due summary changes from 1 to 0. At the finished screen click **Return to list**; the review panel becomes hidden, but the Shadow DOM has no `[data-filter="due"]` control (and no `[data-filter="all"]` control), including after waiting 30 seconds. The automated run records the immediate state as `reviewHidden=true, dueFilterPresent=false` and exits non-zero. Product code was left unchanged; the due/all list count check is **not verified** because the filters do not return.

## Page-state request count

The initial fixture page-state read made **8 HTTP requests** to the AnkiConnect v1 endpoint. The method list was: `notes.search` ×1, `notes.getMany` ×1, `cards.search` ×2, `cards.getMany` ×1, and `scheduling.getDue` ×3. Note and card lookup used batched calls rather than one lookup per fixture word; the due checks were limited to Anki's due-card candidates. The monitor recorded no request to a non-test Anki port.

## Environment and commands

- Anki: `26.09.3`
- AnkiConnect: API major `1` (the endpoint version returned by `api.describe`)
- Scheduler: SM-2
- Chrome for Testing: `Chrome/156.0.8078.47`
- Node.js: `v26.9.0`
- Test endpoint/deck: `127.0.0.1:8766`, `VOKA Test::P1`
- `npm run build` — passed
- `npm test` — passed, 28 files / 196 tests
- `npm run check:p1` — exited 1 because of T-18 above; T-12 through T-17 passed and cleanup printed `CLEANUP OK`

## 人工检查清单（维护者）

- [ ] 1. Turn on FSRS in the test instance (Anki → 牌组选项 → FSRS), re-run `npm run check:p1`, and compare the buttons and intervals shown with Anki's own reviewer.
- [ ] 2. In your own Anki, grade 2–3 real due cards on a real page, then check in Anki → 浏览 that their due date and review history changed.
- [ ] 3. Mark a word you know `我认识` while its card is due, and check it stays hidden on the page but counts in 今日到期.
