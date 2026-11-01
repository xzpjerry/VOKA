# P1–P2 整体验收与回归

## Summary

- Date: 2026-11-01
- Tested source baseline: `49ef8d739568dbf385db5fa4b6cfa2f989646b8d` (`origin/main`)
- Anki: 26.09.3
- AnkiConnect: API v1 (`apiMajor: 1`)
- Chrome for Testing: 156.0.8078.47
- Node.js: v26.9.0
- All Anki checks used only the isolated `http://127.0.0.1:8766` instance and local fixtures. No product code under `src/` changed.

Before running checks, `rg -n '8765' scripts/` found only rejection guards, negative assertions, and comments. A stricter search for port 8765 URL, endpoint, or configuration targets returned no matches. The runtime onboarding audit also recorded 0 requests to 8765 and 1,541 requests to 8766.

`check:all` ran `build` first, then the requested scripts in order. No script was missing. The latest full run exited 1 because six checks reported failures described below; the other twelve passed.

| Script | Status | Exit code | Duration |
| --- | --- | ---: | ---: |
| build | PASS | 0 | 2.4s |
| check:anki | PASS | 0 | 0.4s |
| check:import | PASS | 0 | 4.4s |
| check:level-import | PASS | 0 | 162.0s |
| check:highlight | PASS | 0 | 7.5s |
| check:manual | PASS | 0 | 69.1s |
| check:dynamic | PASS | 0 | 7.3s |
| check:contexts | FAIL | 1 | 139.6s |
| check:scope | PASS | 0 | 16.2s |
| check:gloss-upgrade | PASS | 0 | 350.0s |
| check:due | PASS | 0 | 4.5s |
| check:review | PASS | 0 | 9.9s |
| check:practice | PASS | 0 | 23.7s |
| check:p1 | FAIL | 1 | 168.9s |
| check:epub | FAIL | 1 | 57.7s |
| check:pdf | FAIL | 1 | 36.9s |
| check:youtube | FAIL | 1 | 34.7s |
| check:p0 | FAIL | 1 | 1088.3s |

Run logs, including the last 15 output lines for every command, remain in ignored `.cache/check-all/`.

## Spec §14 checks

Evidence pointers name the test script and the local `.cache/check-all/` log. An earlier complete `check:all` run passed the EPUB, PDF, and YouTube checks; the latest rerun is recorded separately where it stopped before later assertions.

| ID | How it is verified | Result | Evidence pointer |
| --- | --- | --- | --- |
| T-12 | `check:p1`: due list and marks for due, New, future, and suspended cards | ✅ PASS | `scripts/check-p1-acceptance.ts`; `.cache/check-all/check-p1.log` |
| T-12a | `check:p1`: mature underline and known-due count/list behavior | ✅ PASS | `scripts/check-p1-acceptance.ts`; `.cache/check-all/check-p1.log` |
| T-13 | `check:p1`: question front, local sentence, answer reveal | ✅ PASS | `scripts/check-p1-acceptance.ts`; `.cache/check-all/check-p1.log` |
| T-14 | `check:p1`: Again, Hard, Good, Easy each create one record and update scheduling | ✅ PASS | `scripts/check-p1-acceptance.ts`; `.cache/check-all/check-p1.log` |
| T-15 | `check:p1`: already-reviewed card is skipped without a duplicate review | ✅ PASS | `scripts/check-p1-acceptance.ts`; `.cache/check-all/check-p1.log` |
| T-16 | `check:p1`: accepted answer with simulated lost response is confirmed without retry | ✅ PASS | `scripts/check-p1-acceptance.ts`; `.cache/check-all/check-p1.log` |
| T-17 | `check:p1`: practice New and future Review cards without ratings or scheduling changes | ❌ FAIL; reproduced in three runs; issue [#113](https://github.com/xzpjerry/VOKA/issues/113) | `.cache/check-all/check-p1.log`; full card reports “未加入 Anki” for `aborigine`, `absence`, and `absent`, so the practice control never appears |
| T-18 | `check:p1`: due underline, summary, and filters recalculate after review | ✅ PASS | `scripts/check-p1-acceptance.ts`; `.cache/check-all/check-p1.log` |
| T-20 | `check:youtube`: hover pauses across subtitle, tooltip, and full card, then resumes | ✅ PASS in latest run | `scripts/check-youtube.ts`; `.cache/check-all/check-youtube.log` |
| T-21 | `check:youtube`: user pause is preserved | ✅ PASS in latest run | `scripts/check-youtube.ts`; `.cache/check-all/check-youtube.log` |
| T-22 | `check:youtube`: human/automatic English and other-language/no-track caption fixtures | ✅ PASS in the earlier complete run; latest rerun stopped before the later track fixtures | `scripts/check-youtube.ts`; `.cache/check-all/check-youtube.log` |
| T-23 Web | `check:p1` shared web review flow, also covered by T-14 | ✅ PASS | `scripts/check-p1-acceptance.ts`; `.cache/check-all/check-p1.log` |
| T-23 EPUB | `check:epub`: due-card review flow | ✅ PASS in the earlier complete run; latest rerun stopped in the preceding future-card practice check (#114) | `scripts/check-epub.ts`; `.cache/check-all/check-epub.log` |
| T-23 PDF | `check:pdf`: due-card review flow | ✅ PASS in the earlier complete run; latest rerun stopped while loading the due card context (#114) | `scripts/check-pdf.ts`; `.cache/check-all/check-pdf.log` |
| T-23 Video | `check:youtube`: due cue review flow | ✅ PASS in the earlier complete run; latest rerun stopped while loading the first cue card (#114) | `scripts/check-youtube.ts`; `.cache/check-all/check-youtube.log` |
| T-24 | `check:pdf`: text PDF support and image-only PDF unsupported message | ✅ PASS in the earlier complete run; latest rerun passed text-layer marking before stopping at card context (#114) | `scripts/check-pdf.ts`; `.cache/check-all/check-pdf.log` |
| T-24a | `check:epub`: scripts/external resources are removed or blocked | ✅ PASS in latest run | `scripts/check-epub.ts`; `.cache/check-all/check-epub.log` |
| T-24b | `check:epub` and `check:pdf`: saved-position restore | ✅ PASS for EPUB in latest run and PDF in the earlier complete run | `scripts/check-epub.ts`, `scripts/check-pdf.ts`; corresponding `.cache/check-all/` logs |

Issue [#114](https://github.com/xzpjerry/VOKA/issues/114) records the repeated context-loading failure: `check:contexts` timed out twice at the same long-sentence card wait, including inside `check:p0`. In the same latest run, PDF kept its Anki-backed save control disabled, while EPUB and YouTube timed out before their practice/save checks could continue. Both #113 and #114 have the `ready-for-agent` label and are sub-issues of #69.

### P0 regression

`check:p0` returned FAIL because its `contexts` subcheck timed out waiting for the `apple` card on the local `/long` fixture. The other P0 subchecks passed, including T-28 after correcting its card-visibility wait. `check:data` also confirmed that `en-2026.11.1` has no unlisted level entries; the unlisted-word UI is exercised by `check:contexts`.

### Acceptance-harness corrections

The existing harnesses had stale assumptions, so these test-only corrections were made and are included with the report:

- `check-level-import`: bring the fixture tab forward and use locator-based actions to avoid a Puppeteer focus timeout.
- `check-highlight`: include the current “Due today 0” drawer filter in the expected count list.
- `check-data`: handle the current pack’s zero missing-dictionary level entries and point to the unlisted-word case in `check-contexts`.
- `check-candidates`: wait for a visible full card and enabled manual-status button; the old optional selector passed when the card was absent and then dereferenced a null heading.

No application behavior was changed to make these checks pass.

## Build and unit tests

- `npm ci` — passed; installed dependencies including `tsx`, with no reported vulnerabilities.
- `npm run build` — passed (existing large reader bundle warning only).
- `npm test` — passed: 30 files, 209 tests.
- `npm run check:p0 -- --only=candidates` — passed after the candidate harness correction.
- `npm run check:all` — exit 1 on the latest run because `check:contexts`, `check:p1`, `check:epub`, `check:pdf`, `check:youtube`, and `check:p0` exposed the issues above.

## Known limits

- FSRS was not measured; Anki’s reviewer uses SM-2 in this test instance.
- Overdue `scheduling.setDueDate` inputs `-1` and `-2--1` were rejected by Anki; no overdue state was confirmed.
- YouTube was verified only on local fixtures; real videos were not tested.
- EPUB DRM, fixed-layout books, and malformed books were not covered.
- PDF OCR was not tested; mixed text/image pages were not browser-verified.
- AnkiDroid was not tested.

## 人工检查清单（维护者）

1. [ ] 用真实 YouTube 视频检查 T-20、T-21、T-22 和视频里的 T-23；打开诊断行，每个视频只记录字幕获取方法编号，不粘贴字幕文本或视频链接。
2. [ ] 在测试实例里启用 FSRS，重跑 `npm run check:p1`，并与 Anki 自带复习器显示的按钮数量和间隔比较。
3. [ ] 在你自己的 Anki 和真实网页上给 2–3 张真实到期卡评分，再到“浏览”确认到期状态和复习记录已更新。
4. [ ] 找一张到期词卡标记为「我认识」，检查它不显示标注但仍计入今日到期。
5. [ ] 打开你自己的真实 EPUB 和文字型 PDF，抽查标词、查词和保存例句。
