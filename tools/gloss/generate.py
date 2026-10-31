#!/usr/bin/env python3
"""Resumable full-corpus Chinese native gloss generation through the OpenCode CLI.

The corpus is every single-word OEWN lemma shipped in public/data/oewn.json.
Batches are cached under .cache/gloss/ (gitignored); rerunning the same command
skips finished requests. Format-invalid words get two retry rounds; whatever is
still invalid is reported and listed in the generated pack as missing lemmas.

Standard library only. The CLI uses the provider credentials already configured
for OpenCode; this tool never reads, prints or invents API keys.
"""
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
MODEL = "deepseek/deepseek-flash"
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


def cli_version() -> str | None:
    try:
        result = subprocess.run(
            ["opencode", "--version"], capture_output=True, text=True, timeout=30
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
        for lemma, (level, aliases) in pack["entries"].items():
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


def run_cli(request: str, cwd: str, timeout: int) -> dict:
    started = time.monotonic()
    try:
        proc = subprocess.run(
            ["opencode", "run", "--format", "json", "-m", MODEL],
            input=request,
            text=True,
            capture_output=True,
            cwd=cwd,
            timeout=timeout,
        )
        stdout, stderr, returncode = proc.stdout, proc.stderr, proc.returncode
    except subprocess.TimeoutExpired as error:
        return {
            "returncode": None,
            "seconds": round(time.monotonic() - started, 3),
            "answer": "",
            "stderr": f"timeout after {timeout}s: {error}",
            "error_events": [],
            "retryable": True,
        }
    answer, error_events = opencode_answer(stdout)
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
    round_no: int,
    index: int,
    batch: list[dict],
    cwd: str,
    timeout: int,
    max_attempts: int,
    backoff: float,
) -> dict:
    request = request_for(prompt, batch)
    request_sha = sha256(request)
    cached = read_cache(round_no, request_sha)
    if cached is not None:
        return {"index": index, "cached": True, "record": cached, "lemmas": batch}
    attempt = 0
    while True:
        attempt += 1
        result = run_cli(request, cwd, timeout)
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
            "model": MODEL,
            "round": round_no,
            "index": index,
            "lemmas": [word["lemma"] for word in batch],
            "request_sha256": request_sha,
            "cli_version": cli_version(),
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


def collect_round(
    round_no: int, batches: list[list[dict]]
) -> tuple[dict[str, dict], dict[str, list[str]], dict]:
    valid: dict[str, dict] = {}
    invalid: dict[str, list[str]] = {}
    extras: set[str] = set()
    missing_batches = 0
    parse_errors = 0
    seconds = 0.0
    expected = 0
    for batch in batches:
        expected += len(batch)
        request_sha = sha256(request_for(PROMPT, batch))
        record = read_cache(round_no, request_sha)
        if record is None:
            missing_batches += 1
            for word in batch:
                invalid[word["lemma"]] = ["batch result missing"]
            continue
        seconds += float(record.get("seconds") or 0)
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
            errors = validate(word, result_for(record, word["lemma"]))
            if errors:
                invalid[word["lemma"]] = errors
            else:
                valid[word["lemma"]] = result_for(record, word["lemma"])
    return valid, invalid, {
        "round": round_no,
        "words": expected,
        "valid": len(valid),
        "invalid": len(invalid),
        "batches": len(batches),
        "missingBatches": missing_batches,
        "parseErrors": parse_errors,
        "unexpectedLemmas": sorted(extras),
        "generationSeconds": round(seconds, 3),
    }


def run_round(
    round_no: int,
    words: list[dict],
    batch_size: int,
    workers: int,
    cwd: str,
    timeout: int,
    max_attempts: int,
    backoff: float,
) -> dict:
    batches = [words[i : i + batch_size] for i in range(0, len(words), batch_size)]
    if not batches:
        return {"round": round_no, "words": 0, "batches": 0}
    print(
        f"round {round_no}: {len(words)} words in {len(batches)} batches, "
        f"{workers} workers",
        flush=True,
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
            PROMPT, round_no, index, batch, cwd, timeout, max_attempts, backoff
        )
        with lock:
            done += 1
            if not result["cached"]:
                generated += 1
            record = result["record"]
            if record.get("parse_error") or record.get("transport_error"):
                failures += 1
            elapsed = time.monotonic() - started
            rate = done / elapsed if elapsed else 0
            remaining = len(batches) - done
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
        for _ in concurrent.futures.as_completed(
            pool.submit(work, pair) for pair in enumerate(batches)
        ):
            pass
    valid, invalid, stats = collect_round(round_no, batches)
    stats["wallSeconds"] = round(time.monotonic() - started, 3)
    stats["generated"] = generated
    stats["issues"] = failures
    return valid, invalid, stats


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


def assemble(
    words: list[dict],
    valid: dict[str, dict],
    rounds: list[dict],
    prompt_sha: str,
    started_at: str,
    wall_seconds: float,
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
    attribution = (
        "VOKA-generated Simplified Chinese native glosses derived from Open English "
        "WordNet 2025 (CC BY 4.0; includes Princeton WordNet material). Generated "
        f"with model {MODEL} (DeepSeek V4.1 Flash 1017) through the OpenCode CLI on "
        f"{GENERATED_DATE}; prompt SHA-256 {prompt_sha}. Modifications: generated "
        "per single-word OEWN lemma, grouped by OEWN POS, at most three senses per "
        "POS and at most ten Han characters per sense. Chinese text is VOKA's own; "
        "no ECDICT or Wiktionary data is included."
    )
    pack = {
        "source": [OEWN_SOURCE],
        "sourcePack": "oewn.json",
        "license": "CC-BY-4.0; Princeton WordNet notice",
        "version": "2025",
        "generatedDate": GENERATED_DATE,
        "dataVersion": DATA_VERSION,
        "model": MODEL,
        "prompt": "tools/gloss/prompt.txt",
        "promptSha256": prompt_sha,
        "attribution": attribution,
        "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
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
        f"{gzip_size} gzip; {len(missing)} missing",
        flush=True,
    )
    update_metadata(pack, len(raw), gzip_size)
    stats = {
        "model": MODEL,
        "promptSha256": prompt_sha,
        "generatedDate": GENERATED_DATE,
        "dataVersion": DATA_VERSION,
        "sourceLemmaCount": len(words),
        "entryCount": len(entries),
        "missingCount": len(missing),
        "formatInvalidAfterRetries": len(missing),
        "formatValidRate": round(len(entries) / len(words) * 100, 4) if words else 0,
        "missingLemmas": missing,
        "generationSeconds": round(
            sum(float(item.get("generationSeconds") or 0) for item in rounds), 3
        ),
        "wallSeconds": round(wall_seconds, 3),
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
    write_spot_check(words, valid)
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
    print("updated sizes.json and attributions.json", flush=True)


def main() -> None:
    global PROMPT
    parser = argparse.ArgumentParser()
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

    PROMPT = (ROOT / "tools/gloss/prompt.txt").read_text()
    prompt_sha = sha256(PROMPT)
    words, oewn_sha = corpus()
    print(
        f"{len(words)} OEWN lemmas; prompt {prompt_sha[:16]}; oewn {oewn_sha[:16]}",
        flush=True,
    )
    CACHE.mkdir(parents=True, exist_ok=True)
    BATCHES.mkdir(parents=True, exist_ok=True)
    manifest_path = CACHE / "manifest.json"
    manifest = {
        "model": MODEL,
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
    rounds: list[dict] = []
    pending = words
    if args.limit_batches:
        pending = words[: args.limit_batches * args.batch_size]
    if not args.assemble_only:
        with tempfile.TemporaryDirectory(prefix="voka-gloss-") as cwd:
            for round_no in range(args.retries + 1):
                if not pending:
                    break
                found, invalid, stats = run_round(
                    round_no,
                    pending,
                    args.batch_size,
                    args.workers,
                    cwd,
                    args.timeout,
                    args.max_attempts,
                    args.backoff,
                )
                valid.update(found)
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
            found, invalid, stats = collect_round(
                round_no,
                [pending[i : i + args.batch_size] for i in range(0, len(pending), args.batch_size)],
            )
            valid.update(found)
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
        rounds,
        prompt_sha,
        started_at,
        time.monotonic() - started,
    )


if __name__ == "__main__":
    main()
