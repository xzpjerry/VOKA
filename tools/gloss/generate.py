#!/usr/bin/env python3
"""Resumable full-corpus Chinese native gloss generation through the OpenCode CLI.

The corpus is every single-word OEWN lemma shipped in public/data/oewn.json.
Batches are cached under .cache/gloss/ (gitignored); rerunning the same command
skips finished requests. Format-invalid words get two retry rounds; whatever is
still invalid is reported and listed in the generated pack as missing lemmas.

Standard library only. The CLI uses the provider credentials already configured
for OpenCode; this tool never reads, prints or invents API keys.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import datetime
import hashlib
import json
import os
import random
import re
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / ".cache/gloss"
BATCHES = CACHE / "batches"
OUT = ROOT / "public/data"
RESEARCH = ROOT / "docs/research/gloss-full"
LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"]
DEFAULT_MODEL = "deepseek/deepseek-flash"
OPENCODE_PREFIXES = ("opencode/", "deepseek/")
DATA_VERSION = "en-2026.10.1"
GENERATED_DATE = "2026-10-31"
OEWN_SOURCE = (
    "https://github.com/globalwordnet/english-wordnet/releases/download/"
    "2025-edition/english-wordnet-2025-json.zip"
)
LABELS = {"n": "n.", "v": "v.", "a": "adj.", "r": "adv."}
HAN = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\U00020000-\U000323af]{1,10}")
SEED = 20261031
TRANSPORT_MARKERS = re.compile(
    r"\b(429|500|502|503|504)\b|rate.?limit|too many requests|overloaded|"
    r"temporarily unavailable|quota|resource.?exhausted|connection reset|"
    r"timed? ?out",
    re.IGNORECASE,
)


def dump(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    os.replace(temporary, path)


def sha256(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def runner_for(model: str) -> str:
    """OpenCode for provider-prefixed models; Codex CLI otherwise (pilot models)."""
    return "opencode" if model.startswith(OPENCODE_PREFIXES) else "codex"


def output_schema() -> dict:
    return {
        "type": "object",
        "properties": {
            "words": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "lemma": {"type": "string"},
                        "glosses": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "pos": {"type": "string"},
                                    "senses": {
                                        "type": "array",
                                        "items": {"type": "string"},
                                    },
                                },
                                "required": ["pos", "senses"],
                                "additionalProperties": False,
                            },
                        },
                    },
                    "required": ["lemma", "glosses"],
                    "additionalProperties": False,
                },
            }
        },
        "required": ["words"],
        "additionalProperties": False,
    }


def cli_version(executable: str) -> str | None:
    try:
        result = subprocess.run(
            [executable, "--version"], capture_output=True, text=True, timeout=30
        )
    except OSError:
        return None
    return (result.stdout or result.stderr).strip() or None


def levels() -> dict[str, str]:
    """Lowest CEFR level per lemma, using the same alias folding as the pilot."""
    packs = {
        name: json.loads((OUT / f"{name}.json").read_text())
        for name in ["cefrj", "octanove"]
    }
    found: dict[str, str] = {}
    variants: dict[str, list[str]] = {}
    for pack in packs.values():
        for lemma, (level, aliases, *_) in pack["entries"].items():
            found[lemma] = min(found.get(lemma, level), level, key=LEVELS.index)
            variants[lemma] = list(dict.fromkeys(variants.get(lemma, []) + aliases))
    for lemma, aliases in variants.items():
        for alias in aliases:
            if alias != lemma and alias in found:
                found[lemma] = min(found[lemma], found.pop(alias), key=LEVELS.index)
    return found


def corpus() -> tuple[list[dict], str]:
    """All OEWN single-word lemmas in stable sorted order, merged by base POS."""
    oewn_path = OUT / "oewn.json"
    oewn = json.loads(oewn_path.read_text())
    levels_by_lemma = levels()
    words = []
    for lemma in sorted(oewn["entries"]):
        merged: dict[str, list[str]] = {}
        for pos, definitions in oewn["entries"][lemma].items():
            base = pos.split("-")[0]
            for definition in definitions:
                if definition not in merged.setdefault(base, []):
                    merged[base].append(definition)
        words.append(
            {
                "lemma": lemma,
                "level": levels_by_lemma.get(lemma, "Unleveled"),
                "pos": sorted(merged),
                "oewn": merged,
            }
        )
    return words, hashlib.sha256(oewn_path.read_bytes()).hexdigest()


def request_for(prompt: str, batch: list[dict]) -> str:
    return prompt + "\nINPUT:\n" + json.dumps(batch, ensure_ascii=False) + "\n"


def validate(word: dict, result) -> list[str]:
    """The pilot's mechanical format validator, unchanged."""
    errors = []
    if not isinstance(result, dict) or result.get("lemma") != word["lemma"]:
        return ["missing or wrong lemma"]
    groups = result.get("glosses")
    if not isinstance(groups, list):
        return ["glosses must be an array"]
    poses = [g.get("pos") if isinstance(g, dict) else None for g in groups]
    if sorted(str(p) for p in poses) != sorted(word["pos"]):
        errors.append("missing, extra or duplicate POS")
    for group in groups:
        if not isinstance(group, dict):
            errors.append("invalid group")
            continue
        senses = group.get("senses")
        if not isinstance(senses, list) or not 1 <= len(senses) <= 3:
            errors.append("sense count outside 1..3")
            continue
        if len(set(map(str, senses))) != len(senses):
            errors.append("duplicate sense")
        for sense in senses:
            if not isinstance(sense, str) or not HAN.fullmatch(sense):
                errors.append("sense must be 1..10 Han characters")
    return sorted(set(errors))


def opencode_answer(stdout: str) -> tuple[str, list[str]]:
    """Text parts and error messages from `opencode run --format json` events."""
    parts, errors = [], []
    for line in stdout.splitlines():
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") == "text":
            parts.append(event.get("part", {}).get("text", ""))
        elif "error" in str(event.get("type", "")).lower():
            errors.append(json.dumps(event, ensure_ascii=False)[:2000])
    return "".join(parts), errors


def run_cli(request: str, model: str, cwd: str, timeout: int, effort: str = "low") -> dict:
    runner = runner_for(model)
    started = time.monotonic()
    answer_path = None
    if runner == "opencode":
        command = ["opencode", "run", "--format", "json", "-m", model]
    else:
        # The same Codex invocation as the pilot: ephemeral, read-only, empty cwd.
        fd, answer_path = tempfile.mkstemp(dir=cwd, prefix="answer-", suffix=".json")
        os.close(fd)
        command = [
            "codex",
            "exec",
            "--ignore-user-config",
            "--ephemeral",
            "--skip-git-repo-check",
            "--sandbox",
            "read-only",
            "-m",
            model,
            "-c",
            f'model_reasoning_effort="{effort}"',
            "--json",
            "--output-schema",
            str(Path(cwd) / "schema.json"),
            "-o",
            answer_path,
            "-",
        ]
    try:
        proc = subprocess.run(
            command,
            input=request,
            text=True,
            capture_output=True,
            cwd=cwd,
            timeout=timeout,
        )
        stdout, stderr, returncode = proc.stdout, proc.stderr, proc.returncode
    except subprocess.TimeoutExpired as error:
        if answer_path:
            Path(answer_path).unlink(missing_ok=True)
        return {
            "returncode": None,
            "seconds": round(time.monotonic() - started, 3),
            "answer": "",
            "stderr": f"timeout after {timeout}s: {error}",
            "error_events": [],
            "retryable": True,
        }
    if runner == "opencode":
        answer, error_events = opencode_answer(stdout)
    else:
        answer, error_events = "", []
        for line in stdout.splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get("type") in {"error", "turn.failed"}:
                error_events.append(json.dumps(event, ensure_ascii=False)[:2000])
        if answer_path and Path(answer_path).exists():
            answer = Path(answer_path).read_text()
            Path(answer_path).unlink(missing_ok=True)
    retryable = returncode != 0 or not answer.strip()
    if TRANSPORT_MARKERS.search(stderr) or any(
        TRANSPORT_MARKERS.search(value) for value in error_events
    ):
        retryable = True
    return {
        "returncode": returncode,
        "seconds": round(time.monotonic() - started, 3),
        "answer": answer,
        "stderr": stderr[-4000:],
        "error_events": error_events,
        "retryable": retryable,
    }


def cache_path(round_no: int, request_sha: str) -> Path:
    return BATCHES / f"r{round_no}-{request_sha[:24]}.json"


def read_cache(round_no: int, request_sha: str) -> dict | None:
    path = cache_path(round_no, request_sha)
    if not path.exists():
        return None
    try:
        record = json.loads(path.read_text())
    except (json.JSONDecodeError, OSError):
        return None
    if record.get("request_sha256") != request_sha:
        return None
    return record


def generate_one(
    prompt: str,
    model: str,
    round_no: int,
    index: int,
    batch: list[dict],
    cwd: str,
    timeout: int,
    max_attempts: int,
    backoff: float,
    effort: str = "low",
) -> dict:
    request = request_for(prompt, batch)
    request_sha = sha256(request)
    cached = read_cache(round_no, request_sha)
    # Transport failures are not finished work: retry them on the next run.
    # The request hash is model-independent: a cached batch is reused even when
    # a later run selects another model, which is what keeps a mixed pack cheap.
    if cached is not None and not cached.get("transport_error"):
        return {"index": index, "cached": True, "record": cached, "lemmas": batch}
    attempt = 0
    while True:
        attempt += 1
        result = run_cli(request, model, cwd, timeout, effort)
        if result["retryable"] and attempt < max_attempts:
            delay = min(backoff * (2 ** (attempt - 1)), 60) + random.random()
            print(
                f"retry round {round_no} batch {index} attempt {attempt}: "
                f"{result['stderr'][:160] or 'empty answer'}; sleeping {delay:.1f}s",
                flush=True,
            )
            time.sleep(delay)
            continue
        record = {
            "model": model,
            "runner": runner_for(model),
            "effort": effort if runner_for(model) == "codex" else None,
            "round": round_no,
            "index": index,
            "lemmas": [word["lemma"] for word in batch],
            "request_sha256": request_sha,
            "cli_version": cli_version(
                "opencode" if runner_for(model) == "opencode" else "codex"
            ),
            "started_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "seconds": result["seconds"],
            "returncode": result["returncode"],
            "answer": result["answer"],
            "stderr": result["stderr"],
            "error_events": result["error_events"],
            "attempts": attempt,
        }
        if result["retryable"] and not result["answer"].strip():
            record["transport_error"] = (
                result["stderr"][:2000] or "empty answer after retries"
            )
        else:
            try:
                data = json.loads(result["answer"])
                if not isinstance(data, dict) or not isinstance(data.get("words"), list):
                    raise ValueError("answer must be an object with a words array")
            except (json.JSONDecodeError, ValueError) as error:
                record["parse_error"] = str(error)
            else:
                record["data"] = data
        dump(cache_path(round_no, request_sha), record)
        return {
            "index": index,
            "cached": False,
            "record": record,
            "lemmas": batch,
            "attempts": attempt,
        }


def result_for(record: dict | None, lemma: str):
    if not record:
        return None
    data = record.get("data")
    if not isinstance(data, dict):
        return None
    for value in data.get("words", []):
        if isinstance(value, dict) and value.get("lemma") == lemma:
            return value
    return None


def valid_result_for(record: dict | None, word: dict):
    """Prefer a valid duplicate when a model repeats a lemma in one batch."""
    if record and isinstance(record.get("data"), dict):
        for value in record["data"].get("words", []):
            if isinstance(value, dict) and value.get("lemma") == word["lemma"]:
                if not validate(word, value):
                    return value
    return result_for(record, word["lemma"])


def collect_round(
    round_no: int, batches: list[list[dict]]
) -> tuple[dict[str, dict], dict[str, list[str]], dict, dict[str, dict]]:
    valid: dict[str, dict] = {}
    invalid: dict[str, list[str]] = {}
    sources: dict[str, dict] = {}
    extras: set[str] = set()
    missing_batches = 0
    parse_errors = 0
    format_invalid = 0
    missing_words = 0
    seconds = 0.0
    expected = 0
    models: dict[str, int] = {}
    for batch in batches:
        expected += len(batch)
        request_sha = sha256(request_for(PROMPT, batch))
        record = read_cache(round_no, request_sha)
        if record is None:
            missing_batches += 1
            missing_words += len(batch)
            for word in batch:
                invalid[word["lemma"]] = ["batch result missing"]
            continue
        seconds += float(record.get("seconds") or 0)
        model = record.get("model", "unknown")
        models[model] = models.get(model, 0) + 1
        if record.get("parse_error") or record.get("transport_error"):
            parse_errors += 1
        if isinstance(record.get("data"), dict):
            returned = {
                value.get("lemma")
                for value in record["data"].get("words", [])
                if isinstance(value, dict)
            }
            extras.update(returned - {word["lemma"] for word in batch})
        for word in batch:
            result = valid_result_for(record, word)
            errors = validate(word, result)
            if record.get("transport_error"):
                errors = ["transport error: " + record["transport_error"]]
            elif record.get("parse_error"):
                errors = ["parse error: " + record["parse_error"]]
            if errors:
                if not record.get("parse_error") and not record.get("transport_error"):
                    format_invalid += 1
                invalid[word["lemma"]] = errors
            else:
                valid[word["lemma"]] = result
                sources[word["lemma"]] = {
                    "model": model,
                    "runner": record.get("runner", "opencode"),
                    "effort": record.get("effort"),
                    "round": round_no,
                    "batch": record.get("index"),
                    "request_sha256": request_sha,
                }
    return valid, invalid, {
        "round": round_no,
        "words": expected,
        "valid": len(valid),
        "invalid": len(invalid),
        "batches": len(batches),
        "missingBatches": missing_batches,
        "parseErrors": parse_errors,
        "formatInvalidWords": format_invalid,
        "unprocessedWords": missing_words,
        "unexpectedLemmas": sorted(extras),
        "models": models,
        "generationSeconds": round(seconds, 3),
    }, sources


def run_round(
    model: str,
    round_no: int,
    words: list[dict],
    batch_size: int,
    workers: int,
    cwd: str,
    timeout: int,
    max_attempts: int,
    backoff: float,
    effort: str = "low",
):
    batches = [words[i : i + batch_size] for i in range(0, len(words), batch_size)]
    if not batches:
        return {}, {}, {"round": round_no, "words": 0, "batches": 0}, {}
    print(
        f"round {round_no}: {len(words)} words in {len(batches)} batches, "
        f"{workers} workers",
        flush=True,
    )
    cached_count = sum(
        (record := read_cache(round_no, sha256(request_for(PROMPT, batch)))) is not None
        and not record.get("transport_error")
        for batch in batches
    )
    started = time.monotonic()
    lock = threading.Lock()
    done = 0
    generated = 0
    failures = 0

    def work(pair):
        nonlocal done, generated, failures
        index, batch = pair
        result = generate_one(
            PROMPT, model, round_no, index, batch, cwd, timeout, max_attempts, backoff, effort
        )
        with lock:
            done += 1
            if not result["cached"]:
                generated += 1
            record = result["record"]
            if record.get("parse_error") or record.get("transport_error"):
                failures += 1
            elapsed = time.monotonic() - started
            rate = generated / elapsed if elapsed else 0
            remaining = max(0, len(batches) - cached_count - generated)
            eta = remaining / rate if rate else 0
            print(
                f"[round {round_no}] {done}/{len(batches)} "
                f"{'cached' if result['cached'] else 'generated'} "
                f"batch {index} {record.get('seconds')}s "
                f"parse/transport issues {failures} "
                f"rate {rate:.2f} batch/s eta {eta / 60:.1f} min",
                flush=True,
            )
        return result

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        for future in concurrent.futures.as_completed(
            pool.submit(work, pair) for pair in enumerate(batches)
        ):
            future.result()
    valid, invalid, stats, sources = collect_round(round_no, batches)
    stats["wallSeconds"] = round(time.monotonic() - started, 3)
    stats["generated"] = generated
    stats["issues"] = failures
    return valid, invalid, stats, sources


def level_of(words: list[dict]) -> dict[str, str]:
    return {word["lemma"]: word["level"] for word in words}


def display(lemma: str, groups: dict[str, list[str]]) -> str:
    return "　".join(
        f"{LABELS.get(pos, pos)} {'；'.join(groups[pos])}" for pos in sorted(groups)
    )


def write_spot_check(words: list[dict], valid: dict[str, dict]) -> None:
    by_level: dict[str, list[dict]] = {}
    for word in words:
        if word["lemma"] in valid:
            by_level.setdefault(word["level"], []).append(word)
    rng = random.Random(SEED)
    rows = []
    for level in LEVELS + ["Unleveled"]:
        pool = sorted(by_level.get(level, []), key=lambda word: word["lemma"])
        chosen = pool if len(pool) <= 30 else rng.sample(pool, 30)
        for word in sorted(chosen, key=lambda word: word["lemma"]):
            result = valid[word["lemma"]]
            groups = {group["pos"]: group["senses"] for group in result["glosses"]}
            oewn = " | ".join(
                f"{LABELS.get(pos, pos)} {'; '.join(word['oewn'][pos])}"
                for pos in word["pos"]
            )
            rows.append([level, word["lemma"], oewn, display(word["lemma"], groups)])
    RESEARCH.mkdir(parents=True, exist_ok=True)
    import csv

    with (RESEARCH / "spot-check.csv").open("w", encoding="utf-8-sig", newline="") as file:
        writer = csv.writer(file, lineterminator="\n")
        writer.writerow(["CEFR level", "lemma", "OEWN glosses", "generated native gloss"])
        writer.writerows(rows)
    print(f"spot check: {len(rows)} rows -> {RESEARCH / 'spot-check.csv'}", flush=True)


def provenance(record: dict) -> str:
    model = record.get("model", "unknown")
    effort = record.get("effort")
    return f"{model} (effort {effort})" if effort else model


def model_label(models: list[str]) -> str:
    return models[0] if len(models) == 1 else "mixed: " + ", ".join(models)


def write_progress(
    words: list[dict],
    entries: dict[str, dict],
    missing: list[str],
    sources: dict[str, dict],
    batch_size: int,
) -> None:
    """Exact resume state, including which model produced each cached batch."""
    word_map = {word["lemma"]: word for word in words}
    records = []
    timing_records = []
    for path in BATCHES.glob("r*-*.json"):
        try:
            record = json.loads(path.read_text())
            batch = [word_map[lemma] for lemma in record["lemmas"]]
            if record.get("request_sha256") != sha256(request_for(PROMPT, batch)):
                continue
            timing_records.append(record)
            if record.get("round") == 0 and not record.get("transport_error"):
                records.append(record)
        except (json.JSONDecodeError, OSError, KeyError):
            continue
    by_configuration: dict[str, dict] = {}
    for record in records:
        label = provenance(record)
        by_configuration.setdefault(label, {"batches": 0, "retryBatches": 0, "lemmas": 0})["batches"] += 1
    for record in timing_records:
        if record.get("round", 0) > 0:
            label = provenance(record)
            by_configuration.setdefault(label, {"batches": 0, "retryBatches": 0, "lemmas": 0})["retryBatches"] += 1
    for lemma in entries:
        label = provenance(sources.get(lemma, {}))
        by_configuration.setdefault(label, {"batches": 0, "retryBatches": 0, "lemmas": 0})["lemmas"] += 1
    by_model_batches: dict[str, int] = {}
    for record in records:
        model = record.get("model", "unknown")
        by_model_batches[model] = by_model_batches.get(model, 0) + 1
    by_model_lemmas: dict[str, int] = {}
    for lemma in entries:
        model = sources.get(lemma, {}).get("model", "unknown")
        by_model_lemmas[model] = by_model_lemmas.get(model, 0) + 1
    timings = {}
    for record in timing_records:
        label = provenance(record)
        try:
            end = datetime.datetime.fromisoformat(record["started_at"]).timestamp()
        except (KeyError, ValueError):
            continue
        seconds = float(record.get("seconds") or 0)
        timing = timings.setdefault(label, {"first": end - seconds, "last": end, "callSeconds": 0})
        timing["first"] = min(timing["first"], end - seconds)
        timing["last"] = max(timing["last"], end)
        timing["callSeconds"] += seconds
    timing_summary = {label: {
        "callSeconds": round(value["callSeconds"], 3),
        "elapsedEnvelopeSeconds": round(value["last"] - value["first"], 3),
    } for label, value in timings.items()}
    models = sorted(set(by_model_batches) | set(by_model_lemmas))
    total_batches = (len(words) + batch_size - 1) // batch_size
    progress = {
        "status": "complete" if not missing else "partial",
        "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "models": models,
        "batchSize": batch_size,
        "batchesTotal": total_batches,
        "batchesCached": len(records),
        "batchesRemaining": max(0, total_batches - len(records)),
        "lemmasTotal": len(words),
        "lemmasDone": len(entries),
        "lemmasMissing": len(missing),
        "byConfiguration": by_configuration,
        "timingByConfiguration": timing_summary,
        "byModel": {
            model: {
                "batches": by_model_batches.get(model, 0),
                "lemmas": by_model_lemmas.get(model, 0),
            }
            for model in models
        },
        "resumeCommand": (
            "python3 tools/gloss/generate.py --model gpt-6-luna "
            f"--effort max --timeout 1800 --workers 4 --batch-size {batch_size}"
        ),
        "note": (
            "Complete pack."
            if not missing
            else "Partial pack for development; missing native glosses fall back to GlossTarget."
        ),
    }
    RESEARCH.mkdir(parents=True, exist_ok=True)
    dump(RESEARCH / "progress.json", progress)
    print("progress -> docs/research/gloss-full/progress.json", flush=True)
    return progress


def assemble(
    words: list[dict],
    valid: dict[str, dict],
    sources: dict[str, dict],
    rounds: list[dict],
    prompt_sha: str,
    started_at: str,
    wall_seconds: float,
    batch_size: int,
    failures: dict[str, list[str]],
) -> None:
    entries = {}
    missing = []
    for word in words:
        result = valid.get(word["lemma"])
        if not result:
            missing.append(word["lemma"])
            continue
        groups = {group["pos"]: group["senses"] for group in result["glosses"]}
        entries[word["lemma"]] = groups
    models = sorted(
        {sources.get(lemma, {}).get("model", "unknown") for lemma in entries}
    ) or ["unknown"]
    configurations = sorted({provenance(sources.get(lemma, {})) for lemma in entries})
    label = model_label(configurations)
    attribution = (
        "VOKA-generated Simplified Chinese native glosses derived from Open English "
        "WordNet 2025 (CC BY 4.0; includes Princeton WordNet material). Generated "
        f"with model(s) {', '.join(configurations)} through Codex/OpenCode CLI on "
        f"{GENERATED_DATE}; prompt SHA-256 {prompt_sha}. Modifications: generated "
        "per single-word OEWN lemma, grouped by OEWN POS, at most three senses per "
        "POS and at most ten Han characters per sense. Chinese text is VOKA's own; "
        "no ECDICT or Wiktionary data is included."
    )
    progress = write_progress(words, entries, missing, sources, batch_size)
    pack = {
        "source": [OEWN_SOURCE],
        "sourcePack": "oewn.json",
        "license": "CC-BY-4.0; Princeton WordNet notice",
        "version": "2025",
        "generatedDate": GENERATED_DATE,
        "dataVersion": DATA_VERSION,
        "model": label,
        "models": models,
        "configurations": configurations,
        "byConfiguration": progress["byConfiguration"],
        "prompt": "tools/gloss/prompt.txt",
        "promptSha256": prompt_sha,
        "attribution": attribution,
        "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
        "complete": not missing,
        "entryCount": len(entries),
        "sourceLemmaCount": len(words),
        "missingCount": len(missing),
        "missingLemmas": missing,
        "generation": {
            "startedAt": started_at,
            "wallSeconds": round(wall_seconds, 3),
            "rounds": rounds,
        },
        "entries": entries,
    }
    raw = (
        json.dumps(pack, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        + "\n"
    ).encode()
    (OUT / "gloss-zh.json").write_bytes(raw)
    import gzip

    gzip_size = len(gzip.compress(raw, mtime=0))
    print(
        f"gloss-zh.json: {len(entries)} entries, {len(raw)} raw, "
        f"{gzip_size} gzip; {len(missing)} missing; models {models}",
        flush=True,
    )
    update_metadata(pack, len(raw), gzip_size)
    processed = len(words) - (rounds[0].get("unprocessedWords", 0) if rounds else len(words))
    stats = {
        "model": label,
        "models": models,
        "complete": not missing,
        "promptSha256": prompt_sha,
        "generatedDate": GENERATED_DATE,
        "dataVersion": DATA_VERSION,
        "sourceLemmaCount": len(words),
        "entryCount": len(entries),
        "missingCount": len(missing),
        "formatInvalidAfterRetries": sum(
            reasons != ["batch result missing"] and not any(reason.startswith(("parse error:", "transport error:")) for reason in reasons)
            for reasons in failures.values()
        ),
        "unprocessedCount": len(words) - processed,
        "processedCount": processed,
        "formatValidRate": round(len(entries) / processed * 100, 4) if processed else 0,
        "formatViolationRateAfterRetries": round(sum(
            reasons != ["batch result missing"] and not any(reason.startswith(("parse error:", "transport error:")) for reason in reasons)
            for reasons in failures.values()
        ) / processed * 100, 4) if processed else 0,
        "coveragePercent": round(len(entries) / len(words) * 100, 4) if words else 0,
        "missingLemmas": missing,
        "generationSeconds": round(
            sum(float(item.get("generationSeconds") or 0) for item in rounds), 3
        ),
        "wallSeconds": round(wall_seconds, 3),
        "batchesCached": progress["batchesCached"],
        "batchesTotal": progress["batchesTotal"],
        "byModel": progress["byModel"],
        "byConfiguration": progress["byConfiguration"],
        "timingByConfiguration": progress["timingByConfiguration"],
        "rounds": rounds,
        "byLevel": {
            level: {
                "lemmas": sum(word["level"] == level for word in words),
                "generated": sum(
                    word["level"] == level and word["lemma"] in entries for word in words
                ),
                "missing": sum(
                    word["level"] == level and word["lemma"] not in entries
                    for word in words
                ),
            }
            for level in LEVELS + ["Unleveled"]
        },
    }
    RESEARCH.mkdir(parents=True, exist_ok=True)
    dump(RESEARCH / "stats.json", stats)
    dump(RESEARCH / "failures.json", {lemma: failures.get(lemma, ["not processed"]) for lemma in missing})
    write_spot_check(words, valid)
    report = [
        "# Native gloss generation report (#30)", "",
        f"Generated {len(entries):,} / {len(words):,} OEWN lemmas; {len(missing):,} missing. "
        f"Pack complete: {not missing}. Data version: {DATA_VERSION}.", "",
        f"Pack size: {len(raw):,} bytes raw / {gzip_size:,} bytes gzip.", "",
        f"Processed-word format-valid rate: {stats['formatValidRate']:.4f}%; "
        f"remaining format violations: {stats['formatInvalidAfterRetries']:,} "
        f"({stats['formatViolationRateAfterRetries']:.4f}%). "
        f"Unprocessed words: {stats['unprocessedCount']:,}; "
        "coverage and format compliance are separate measures.", "",
        "| Model / effort | Round-0 batches | Retry batches | Valid lemmas |", "|---|---:|---:|---:|",
    ]
    for configuration, counts in progress["byConfiguration"].items():
        report.append(f"| {configuration} | {counts['batches']} | {counts['retryBatches']} | {counts['lemmas']} |")
    report += ["", "Timing from cached requests (parallel call durations overlap):", ""]
    for configuration, timing in progress["timingByConfiguration"].items():
        report.append(f"- {configuration}: {timing['callSeconds']:,.3f} cumulative call seconds; "
                      f"{timing['elapsedEnvelopeSeconds']:,.3f} elapsed seconds from first to last cached result.")
    report += ["", f"This assembly invocation took {wall_seconds:.3f} seconds. "
               "Elapsed envelopes include pauses between calls and exclude failed attempts that produced no cache record.", "",
               "The unchanged pilot prompt and validator require exact POS coverage, one to three distinct "
               "senses per POS, and one to ten Han characters per sense. Two retry rounds are allowed; "
               "an assemble-only snapshot does not generate retries.", "",
               "See [stats.json](stats.json) for per-round/per-level counts, "
               "[failures.json](failures.json) for every missing lemma and its last known reason, "
               "and [progress.json](progress.json) for the exact resume command. "
               "[spot-check.csv](spot-check.csv) contains 30 seeded random generated entries per CEFR level "
               "plus 30 unleveled entries, with OEWN grounding alongside the Chinese glosses. "
               "This is a human-review sample, not a claim that full-corpus semantic quality has been reviewed.", ""]
    (RESEARCH / "generation-report.md").write_text("\n".join(report))
    print(json.dumps(stats["byLevel"], ensure_ascii=False), flush=True)


def update_metadata(pack: dict, raw_size: int, gzip_size: int) -> None:
    sizes_path = OUT / "sizes.json"
    sizes = json.loads(sizes_path.read_text())
    sizes.pop("gloss-zh.json", None)
    ordered = {}
    for name, value in sizes.items():
        if name == "attributions.json":
            ordered["gloss-zh.json"] = {"raw": raw_size, "gzip": gzip_size}
        ordered[name] = value
    if "gloss-zh.json" not in ordered:
        ordered["gloss-zh.json"] = {"raw": raw_size, "gzip": gzip_size}
    sizes_path.write_text(json.dumps(ordered, indent=2) + "\n")

    attributions_path = OUT / "attributions.json"
    metadata = json.loads(attributions_path.read_text())
    metadata["packs"] = [
        item
        for item in metadata["packs"]
        if not (item.get("sourcePack") == "oewn.json" and item.get("model"))
    ]
    gloss_metadata = {
        key: value
        for key, value in pack.items()
        if key not in {"entries", "missingLemmas", "generation"}
    }
    gloss_metadata["rawBytes"] = raw_size
    gloss_metadata["gzipBytes"] = gzip_size
    metadata["packs"].append(gloss_metadata)
    metadata["dataVersion"] = DATA_VERSION
    attributions_path.write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2) + "\n"
    )
    import gzip
    attribution_raw = attributions_path.read_bytes()
    ordered["attributions.json"] = {"raw": len(attribution_raw), "gzip": len(gzip.compress(attribution_raw, mtime=0))}
    sizes_path.write_text(json.dumps(ordered, indent=2) + "\n")
    print("updated sizes.json and attributions.json", flush=True)


def main() -> None:
    if "--supplement" in sys.argv:
        from supplement import main as supplement_main
        sys.exit(supplement_main([arg for arg in sys.argv[1:] if arg != "--supplement"]))
    global PROMPT
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--effort", default="low", choices=["low", "medium", "high", "xhigh", "max"])
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--batch-size", type=int, default=100)
    parser.add_argument("--retries", type=int, default=2)
    parser.add_argument("--timeout", type=int, default=900)
    parser.add_argument("--max-attempts", type=int, default=6)
    parser.add_argument("--backoff", type=float, default=2.0)
    parser.add_argument("--limit-batches", type=int)
    parser.add_argument("--assemble-only", action="store_true")
    parser.add_argument("--no-assemble", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.workers <= 32:
        parser.error("workers must be 1..32")
    if not 1 <= args.batch_size <= 200:
        parser.error("batch size must be 1..200")
    if not 0 <= args.retries <= 2:
        parser.error("format retries must be 0..2")
    if args.max_attempts < 1 or args.timeout < 1 or args.backoff < 0:
        parser.error("max-attempts and timeout must be positive; backoff must be nonnegative")
    if not args.model.strip():
        parser.error("model must not be empty")

    PROMPT = (ROOT / "tools/gloss/prompt.txt").read_text()
    prompt_sha = sha256(PROMPT)
    words, oewn_sha = corpus()
    print(
        f"{len(words)} OEWN lemmas; prompt {prompt_sha[:16]}; oewn {oewn_sha[:16]}; "
        f"model {args.model} ({runner_for(args.model)})",
        flush=True,
    )
    CACHE.mkdir(parents=True, exist_ok=True)
    BATCHES.mkdir(parents=True, exist_ok=True)
    manifest_path = CACHE / "manifest.json"
    manifest = {
        "promptSha256": prompt_sha,
        "oewnSha256": oewn_sha,
        "batchSize": args.batch_size,
        "sourceLemmaCount": len(words),
    }
    if manifest_path.exists():
        old = json.loads(manifest_path.read_text())
        if old != manifest:
            print(
                "cache manifest differs (prompt, corpus or batch size changed); "
                "existing request caches are content-addressed and still safe",
                flush=True,
            )
    dump(manifest_path, manifest)

    started_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
    started = time.monotonic()
    valid: dict[str, dict] = {}
    sources: dict[str, dict] = {}
    rounds: list[dict] = []
    invalid: dict[str, list[str]] = {}
    failure_reasons: dict[str, list[str]] = {}
    pending = words
    if args.limit_batches:
        pending = words[: args.limit_batches * args.batch_size]
    if not args.assemble_only:
        with tempfile.TemporaryDirectory(prefix="voka-gloss-") as cwd:
            dump(Path(cwd) / "schema.json", output_schema())
            for round_no in range(args.retries + 1):
                if not pending:
                    break
                found, invalid, stats, found_sources = run_round(
                    args.model,
                    round_no,
                    pending,
                    args.batch_size,
                    args.workers,
                    cwd,
                    args.timeout,
                    args.max_attempts,
                    args.backoff,
                    args.effort,
                )
                for lemma, reasons in invalid.items():
                    if reasons != ["batch result missing"] or lemma not in failure_reasons:
                        failure_reasons[lemma] = reasons
                for lemma in found:
                    failure_reasons.pop(lemma, None)
                valid.update(found)
                sources.update(found_sources)
                rounds.append(stats)
                print(json.dumps(stats, ensure_ascii=False), flush=True)
                pending = [word for word in pending if word["lemma"] in invalid]
    else:
        # Reconstruct final results from all cached rounds without generating.
        for round_no in range(args.retries + 1):
            pending = pending if round_no == 0 else [
                word for word in pending if word["lemma"] not in valid
            ]
            if not pending:
                break
            found, invalid, stats, found_sources = collect_round(
                round_no,
                [pending[i : i + args.batch_size] for i in range(0, len(pending), args.batch_size)],
            )
            for lemma, reasons in invalid.items():
                if reasons != ["batch result missing"] or lemma not in failure_reasons:
                    failure_reasons[lemma] = reasons
            for lemma in found:
                failure_reasons.pop(lemma, None)
            valid.update(found)
            sources.update(found_sources)
            rounds.append(stats)
            pending = [word for word in pending if word["lemma"] in invalid]

    if args.limit_batches:
        # A limited run must not overwrite the production pack with partial data.
        if valid:
            write_spot_check(words, valid)
        print("limited run; production pack not written", flush=True)
        return
    if args.no_assemble:
        print("no-assemble; production pack not written", flush=True)
        return
    assemble(
        words,
        valid,
        sources,
        rounds,
        prompt_sha,
        started_at,
        time.monotonic() - started,
        args.batch_size,
        failure_reasons,
    )


if __name__ == "__main__":
    main()
