# Chinese native gloss pilot — issue #28

This is a 300-word human review set, **not approval for full generation** (#30). Fill `cheap_ok (Y/N)`, `mid_ok (Y/N)` and `notes` in [comparison.csv](comparison.csv) (UTF-8 BOM), or inspect [the Markdown preview](comparison.md). Format validity is mechanical; it does not measure translation quality. Human scoring and the per-level model decision remain outstanding.

## Reproduction

Requires Python 3.10+ (standard library), authenticated Codex CLI and OpenCode CLI, and the committed `public/data` packs. No API key is created or required by this script. Run from the repository root:

```sh
python3 tools/gloss/pilot.py sample
python3 tools/gloss/pilot.py generate --model gpt-6-luna
python3 tools/gloss/pilot.py generate --model gpt-6.1-sol
python3 tools/gloss/pilot.py generate --model opencode/deepseek-v4.1-flash-free
python3 tools/gloss/pilot.py compare
python3 -m unittest discover -s tools/gloss -p 'test_*.py'
```

Sampling is deterministic (Python Random seed `20261031`, sorted pools, 40 A1/A2/B1/B2/C1/C2 and 60 unleveled OEWN lemmas). `light`, `present`, `lead`, `bank`, `run` replace random slots in their own strata. Lowest levels and spelling-alias folding follow the production loader; only canonical words found in OEWN are eligible. OEWN numbered homograph groups (e.g. `lead` `n-1`/`n-2`) are merged into their base POS with distinct definitions retained before prompting. The sample records source SHA-256 hashes. Custom lemma lists can replace `sample.json`'s `words` array, retaining each word's lemma, level, POS list and OEWN groups; keep this pilot bounded to 300 words. The generation command only reads this sample and never traverses the corpus.

The exact common prompt is [prompt.txt](../../../tools/gloss/prompt.txt). Every batch also records its complete request (`*.prompt.txt`), unmodified machine-readable final answer (`NN.json`), CLI JSONL events, stderr and metadata. The Codex models `gpt-6-luna` and `gpt-6.1-sol` use batch size 25, reasoning effort `low`, ephemeral sessions, read-only sandbox, user config ignored, JSON Schema output, and an empty temporary working directory. Codex CLI version: `0.166.0`.

`opencode/deepseek-v4.1-flash-free` uses the same batch size, prompt and empty temporary working directory, invoked as `opencode run --format json -m opencode/deepseek-v4.1-flash-free` with the request on stdin. OpenCode CLI version: `2.2.5`. OpenCode has no JSON Schema flag, so the answer is the concatenation of the final text events, saved verbatim as `NN.answer.txt`, and accepted only if it parses as one JSON object with a `words` array; parse failures are recorded in metadata and counted as format-invalid rather than repaired. Raw artifacts live in `deepseek-v4.1-flash-free/` alongside the two Codex directories. Each metadata file records the exact argv, CLI version, request/output hashes, elapsed seconds and exit code; temporary schema paths are session-specific. Temperature and model seed are not exposed/set. Each CLI still supplies its own system context; token counts include that overhead.

Successful cached batches are reused only when their full request hashes match; changed inputs fail closed. To obtain fresh model responses, move the model output directories aside before generation. Sampling, prompting and formatting are reproducible; newly generated responses may vary because inference is nondeterministic and model aliases can change. Do not compare results generated with different sample files.

## Validation and review limits

The validator requires exactly one word and exactly one group per supplied POS, 1–3 distinct senses per group, and 1–10 Han Unicode code points per sense. Empty, missing, extra, repeated or malformed groups/senses are flagged; no response is silently fixed. Codex JSON parsing or CLI failures stop the run; an unparseable OpenCode answer is recorded in metadata and counted as format-invalid for that batch rather than repaired. Display labels map OEWN `a/r` to `adj./adv.`; groups use ideographic spaces and senses use `；`. CSV has separate format-valid columns and intentionally blank human scoring columns. Unexpected response lemmas are recorded in stats.

Inputs use the **already truncated pack: first two OEWN definitions per source POS/homograph group**, not full OEWN senses. Merging numbered homograph groups can retain more than two input definitions for a base POS (four noun definitions for `lead`); outputs still allow at most three senses. Thus e.g. common meanings missing from those two definitions cannot be assessed or recovered by this pilot. Human reviewers should score faithfulness to the supplied definitions as well as usefulness, and flag unsuitable source-sense selection separately. Proper names, obscure technical words and transliterations in the unleveled stratum are intentional. This is neither a frequency-weighted estimate of all OEWN words nor a quality guarantee for missing-dictionary words.

[stats.json](stats.json) records format violations, per-model elapsed batch time and reported usage. Batch times are sums of wall-clock request durations; model runs may overlap. Dollar cost is unavailable through Codex CLI subscription execution and is not estimated; OpenCode reports `$0` for this free model. Scores are blank and no semantic error rates or per-level escalation decisions are claimed. Adding the DeepSeek column did not rerun the Codex models: `compare` re-read their cached `NN.json` batches, and all 3,300 cells in the eleven pre-existing CSV columns matched the previously committed comparison byte-for-byte.

## Sources and attribution

Adapted from Open English WordNet 2025, Open English WordNet Team, CC BY 4.0, including Princeton WordNet material. OEWN grounding is copied from the normalized VOKA `en-2026.10` pack; Chinese text is generated by VOKA. Levels derive from The CEFR-J Wordlist Version 1.6, compiled by Yukio Tono, Tokyo University of Foreign Studies (copyright Tono Laboratory), and Octanove Vocabulary Profile C1/C2 1.0, Octanove Labs, CC BY-SA 4.0. Modifications: sampling, lowest-level normalization, alias folding and human review formatting. Retain the respective source terms; see [complete notices and attributions](../../../public/data/attributions.json) and [data build documentation](../../../tools/data/README.md). This research table does not resolve the spec §7.3 publication licensing gates.

## Recorded run

- `gpt-6-luna`: 2/300 format-invalid words; 117.072 summed batch seconds; 190,503 input tokens (27,392 cached), 9,164 output tokens.
- `gpt-6.1-sol`: 0/300 format-invalid words; 171.068 summed batch seconds; 196,352 input tokens (0 cached), 9,241 output tokens.
- `opencode/deepseek-v4.1-flash-free`: 0/300 format-invalid words; 366.286 summed batch seconds; 49,096 reported input tokens and 76,160 cache-read input tokens, 8,681 output tokens, 38,210 reasoning tokens; reported cost `$0`.

Luna repeats the adjective sense for `motor` (B1) and exceeds three noun senses for `lead` (A2); both are retained and flagged. All POS coverage, count and length checks pass for Sol and DeepSeek. These are mechanical results, pending human semantic scores. Stats cover the retained final batches; an earlier 25-word batch per model was regenerated after normalizing `lead` homograph POS groups, so total exploratory usage was higher than the retained snapshot. DeepSeek's 12 batches were generated once against the same cached sample and prompt; its raw events, answers and metadata are retained under `deepseek-v4.1-flash-free/`.
