# Native gloss generation report (#30)

Generated 45,096 / 74,441 OEWN lemmas; 29,345 missing. Pack complete: False. Data version: en-2026.10.1.

Pack size: 2,106,381 bytes raw / 651,554 bytes gzip.

Processed-word format-valid rate: 99.9911%; remaining format violations: 4 (0.0089%). Unprocessed words: 29,341; coverage and format compliance are separate measures.

| Model / effort | Round-0 batches | Valid lemmas |
|---|---:|---:|
| gpt-6-luna (effort max) | 109 | 10897 |
| deepseek/deepseek-flash | 342 | 34199 |

Timing from cached requests (parallel call durations overlap):

- gpt-6-luna (effort max): 5,865.002 cumulative call seconds; 1,486.632 elapsed seconds from first to last cached result.
- deepseek/deepseek-flash: 14,482.881 cumulative call seconds; 2,042.925 elapsed seconds from first to last cached result.

This assembly invocation took 0.658 seconds. Elapsed envelopes include pauses between calls and exclude failed attempts that produced no cache record.

The unchanged pilot prompt and validator require exact POS coverage, one to three distinct senses per POS, and one to ten Han characters per sense. Two retry rounds are allowed; an assemble-only snapshot does not generate retries.

See [stats.json](stats.json) for per-round/per-level counts, [failures.json](failures.json) for every missing lemma and its last known reason, and [progress.json](progress.json) for the exact resume command. [spot-check.csv](spot-check.csv) contains 30 seeded random generated entries per CEFR level plus 30 unleveled entries, with OEWN grounding alongside the Chinese glosses. This is a human-review sample, not a claim that full-corpus semantic quality has been reviewed.
