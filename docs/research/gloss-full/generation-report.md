# Native gloss generation report (#30)

Generated 74,441 / 74,441 OEWN lemmas; 0 missing. Pack complete: True. Data version: en-2026.10.1.

Pack size: 3,007,109 bytes raw / 969,513 bytes gzip.

Processed-word format-valid rate: 100.0000%; remaining format violations: 0 (0.0000%). Unprocessed words: 0; coverage and format compliance are separate measures.

| Model / effort | Round-0 batches | Retry batches | Valid lemmas |
|---|---:|---:|---:|
| gpt-6-luna (effort max) | 403 | 1 | 40242 |
| deepseek/deepseek-flash | 342 | 0 | 34199 |

Timing from cached requests (parallel call durations overlap):

- gpt-6-luna (effort max): 21,036.072 cumulative call seconds; 5,319.688 elapsed seconds from first to last cached result.
- deepseek/deepseek-flash: 14,482.881 cumulative call seconds; 2,042.925 elapsed seconds from first to last cached result.

This assembly invocation took 0.868 seconds. Elapsed envelopes include pauses between calls and exclude failed attempts that produced no cache record.

The unchanged pilot prompt and validator require exact POS coverage, one to three distinct senses per POS, and one to ten Han characters per sense. Two retry rounds are allowed; an assemble-only snapshot does not generate retries.

See [stats.json](stats.json) for per-round/per-level counts, [failures.json](failures.json) for every missing lemma and its last known reason, and [progress.json](progress.json) for the exact resume command. [spot-check.csv](spot-check.csv) contains 30 seeded random generated entries per CEFR level plus 30 unleveled entries, with OEWN grounding alongside the Chinese glosses. This is a human-review sample, not a claim that full-corpus semantic quality has been reviewed.
