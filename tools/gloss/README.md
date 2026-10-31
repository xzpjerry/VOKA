# Native gloss pipeline

`prompt.txt` is the shared, versioned prompt for every generation path.

## Pilot (research only)

`pilot.py` produced the 300-word model comparison in
[`docs/research/gloss-pilot/`](../../docs/research/gloss-pilot/README.md). It
samples across CEFR bands, calls Codex CLI for `gpt-6-luna`/`gpt-6.1-sol` and
OpenCode CLI for the DeepSeek column, validates mechanically, and writes the
comparison CSV. Keep the three model directories together as one research
snapshot. The pilot is deliberately limited to 300 words.

## Full corpus (`generate.py`)

The maintainer decision on #29 selects **DeepSeek official
`deepseek/deepseek-flash` (DeepSeek V4.1 Flash 1017)** through the OpenCode CLI
for every lemma and every CEFR band. `generate.py` implements the production
run:

```sh
python3 tools/gloss/generate.py --workers 4 --batch-size 100
```

* Corpus: all 74,441 single-word lemmas in the committed `public/data/oewn.json`.
  POS groups merge OEWN sense-number suffixes (`n-1` + `n-2` → `n`). The input
  records (`lemma`, `level`, `pos`, `oewn`) and the prompt are the same shape and
  rules as the pilot.
* Calls `opencode run --format json -m deepseek/deepseek-flash` in an empty
  temporary directory. It never reads, prints or invents an API key; OpenCode's
  configured provider credentials are used.
* Every batch request is cached under `.cache/gloss/batches/` by its content
  SHA-256. Rerunning the command skips finished requests, so an interrupted run
  resumes for free. The cache is gitignored and never committed.
* Four concurrent calls by default. Transport errors, including HTTP 429/5xx and
  empty answers, retry with exponential backoff and jitter (six attempts by
  default). A batch result that is parseable but fails the mechanical format
  validator is cached, then its words are retried in up to two fresh rounds.
* Writes `public/data/gloss-zh.json` as a separate, independently versioned
  pack with the OEWN source URL, CC BY 4.0 attribution and Princeton notice
  pointer, model id, prompt SHA-256, generated date, data version, entry count,
  coverage and the exact missing-lemma list. It also updates
  `public/data/sizes.json` and `public/data/attributions.json` so the Options
  About section shows the new source.
* Writes `docs/research/gloss-full/stats.json` and a 30-row-per-level
  `spot-check.csv` for human review.

Useful partial commands:

```sh
# Rebuild the pack from an existing cache without new model calls.
python3 tools/gloss/generate.py --assemble-only

# Generate only the first 5 batches (never writes the production pack).
python3 tools/gloss/generate.py --limit-batches 5
```

`--assemble-only` with the production cache is the resume/inspection path; the
pack is only written when a full run (or explicit assemble) succeeds.
