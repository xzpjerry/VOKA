"""POS-filtered level gap generation, using generate.py's Codex cache/provenance path."""

import argparse, csv, gzip, json, random, sys, tempfile
from pathlib import Path
import generate as g

ROOT = g.ROOT
OUT = g.OUT
REPORT = ROOT / "docs/research/leveled-pos-glosses"
VERSION = "en-2026.11.1"


def prepare():
    levels = {}
    aliases = {}
    suppressed = {}
    for name in ["cefrj", "octanove"]:
        pack = json.loads((OUT / f"{name}.json").read_text())
        for lemma, collision in pack.get("caseCollisions", {}).items():
            suppressed[lemma] = collision["suppressedPos"]
        for lemma, (level, variants, poses) in json.loads(
            (OUT / f"{name}.json").read_text()
        )["entries"].items():
            e = levels.setdefault(lemma, {"level": level, "variants": [], "pos": []})
            e["level"] = min(e["level"], level, key=g.LEVELS.index)
            e["variants"] = sorted(set(e["variants"] + variants))
            e["pos"] = sorted(set(e["pos"] + poses))
    for lemma, e in levels.items():
        for alias in e["variants"]:
            aliases[alias] = lemma
    for alias, lemma in aliases.items():
        if alias != lemma and alias in levels:
            a = levels.pop(alias)
            e = levels[lemma]
            e["level"] = min(e["level"], a["level"], key=g.LEVELS.index)
            e["pos"] = sorted(set(e["pos"] + a["pos"]))
            e["variants"] = sorted(set(e["variants"] + a["variants"] + [alias]))
    for lemma, poses in suppressed.items():
        if lemma in levels:
            levels[lemma]["pos"] = [p for p in levels[lemma]["pos"] if p not in poses]
    native = json.loads((OUT / "gloss-zh.json").read_text())["entries"]
    target = json.loads((OUT / "oewn.json").read_text())["entries"]
    morph = json.loads((OUT / "morphology.json").read_text())
    reuse = {}
    gaps = []

    def groups(pack, word, pos):
        return [
            s
            for p, ss in pack.get(word, {}).items()
            if p.split("-")[0].replace("s", "a") == pos
            for s in ss
        ][:3]

    for lemma, e in sorted(levels.items()):
        missing = []
        for pos in e["pos"]:
            candidates = [lemma] + e["variants"]
            # Exact spelling first, then explicit morphology exceptions and conservative suffix rules.
            candidates += morph["entries"].get(pos, {}).get(lemma, [])
            for suffix, replacement in morph.get("rules", {}).get(pos, []):
                if lemma.endswith(suffix):
                    candidates.append(lemma[: -len(suffix)] + replacement)
            # Lexical plural: good's benefit/virtue senses do not mean merchandise.
            if lemma == "goods":
                candidates = [lemma] + e["variants"]
            match = next(
                (
                    w
                    for w in candidates
                    if groups(native, w, pos) and groups(target, w, pos)
                ),
                None,
            )
            if match:
                reuse.setdefault(lemma, {})[pos] = {
                    "native": groups(native, match, pos),
                    "target": groups(target, match, pos),
                    "from": match,
                }
            else:
                missing.append(pos)
        if missing:
            gaps.append({"lemma": lemma, "level": e["level"], "pos": missing})
    # Keep the original supplement batch membership stable when adding this correction.
    gaps.sort(key=lambda word: (word["lemma"] == "goods", word["lemma"]))
    return levels, reuse, gaps


def validate(word, result):
    errors = g._native_validate(word, result)
    if isinstance(result, dict):
        for group in result.get("glosses", []):
            ss = group.get("targetSenses")
            if (
                not isinstance(ss, list)
                or not 1 <= len(ss) <= 3
                or any(
                    not isinstance(s, str)
                    or not s.strip()
                    or len(s) > 240
                    or "<" in s
                    or ">" in s
                    for s in ss
                )
            ):
                errors.append("invalid English senses")
    return errors


def main(argv):
    p = argparse.ArgumentParser()
    p.add_argument("--model", default="gpt-6-luna")
    p.add_argument("--effort", default="max")
    p.add_argument("--assemble-only", action="store_true")
    p.add_argument("--timeout", type=int, default=1800)
    p.add_argument("--workers", type=int, default=4)
    p.add_argument("--batch-size", type=int, default=40)
    args = p.parse_args(argv)
    if args.model != "gpt-6-luna" or args.effort != "max":
        p.error("supplement requires gpt-6-luna --effort max")
    levels, reuse, words = prepare()
    REPORT.mkdir(parents=True, exist_ok=True)
    g.BATCHES = ROOT / ".cache/gloss-supplement/batches"
    g.BATCHES.mkdir(parents=True, exist_ok=True)
    g.PROMPT = (ROOT / "tools/gloss/supplement-prompt.txt").read_text()
    g._native_validate = g.validate
    g.validate = validate
    schema = g.output_schema()
    group = schema["properties"]["words"]["items"]["properties"]["glosses"]["items"]
    group["properties"]["targetSenses"] = {"type": "array", "items": {"type": "string"}}
    group["required"].append("targetSenses")
    print(
        f"{len(levels)} leveled lemmas; {len(words)} supplement lemmas / {sum(len(w['pos']) for w in words)} POS gaps",
        flush=True,
    )
    valid = {}
    sources = {}
    pending = words
    rounds = []
    with tempfile.TemporaryDirectory(prefix="voka-supplement-") as cwd:
        g.dump(Path(cwd) / "schema.json", schema)
        for round_no in range(3):
            if not pending:
                break
            batches = [
                pending[i : i + args.batch_size]
                for i in range(0, len(pending), args.batch_size)
            ]
            if args.assemble_only:
                found, invalid, stats, provenance = g.collect_round(round_no, batches)
            else:
                found, invalid, stats, provenance = g.run_round(
                    args.model,
                    round_no,
                    pending,
                    args.batch_size,
                    args.workers,
                    cwd,
                    args.timeout,
                    1,
                    0,
                    args.effort,
                )
            valid.update(found)
            sources.update(provenance)
            rounds.append(stats)
            for word in pending:
                if word["lemma"] in provenance:
                    sources[word["lemma"]]["pos"] = word["pos"]
            pending = [w for w in pending if w["lemma"] in invalid]
            print(json.dumps(stats), flush=True)
            # Quota exhaustion pauses immediately, preserving resumable caches.
            records = [
                g.read_cache(round_no, g.sha256(g.request_for(g.PROMPT, b)))
                for b in batches
            ]
            if any(
                r
                and any(
                    s in json.dumps(r).lower()
                    for s in [
                        "usage limit",
                        "quota",
                        "credit balance",
                        "insufficient credits",
                    ]
                )
                for r in records
            ):
                g.dump(
                    REPORT / "progress.json",
                    {"status": "PAUSED", "missing": pending, "rounds": rounds},
                )
                return 2
    entries = {
        lemma: {
            pos: {"native": v["native"], "target": v["target"]}
            for pos, v in poses.items()
        }
        for lemma, poses in reuse.items()
    }
    for lemma, result in valid.items():
        for group in result["glosses"]:
            entries.setdefault(lemma, {})[group["pos"]] = {
                "native": group["senses"],
                "target": group["targetSenses"],
            }
    pack = {
        "source": ["CEFR-J 1.6", "Octanove 1.0", "oewn.json", "gloss-zh.json"],
        "license": "CC-BY-4.0; Princeton WordNet notice for reused definitions; independent level source licenses retained",
        "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
        "version": "1",
        "dataVersion": VERSION,
        "generatedDate": "2026-11-01",
        "attribution": "VOKA-generated bilingual learner gloss supplement, gpt-6-luna effort max; reused content from separately attributed OEWN and VOKA native packs. Level POS selection from CEFR-J / Octanove.",
        "model": args.model,
        "effort": args.effort,
        "prompt": "tools/gloss/supplement-prompt.txt",
        "promptSha256": g.sha256(g.PROMPT),
        "entryCount": len(entries),
        "complete": not pending,
        "missing": pending,
        "provenance": sources,
        "entries": entries,
    }
    pack["sourcePackSha256"] = {
        name: g.sha256((OUT / name).read_text())
        for name in [
            "cefrj.json",
            "octanove.json",
            "oewn.json",
            "gloss-zh.json",
            "morphology.json",
        ]
    }
    (OUT / "gloss-leveled.json").write_text(
        json.dumps(pack, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        + "\n"
    )
    g.dump(
        REPORT / "reuse.json",
        {
            lemma: {pos: v["from"] for pos, v in poses.items() if v["from"] != lemma}
            for lemma, poses in reuse.items()
            if any(v["from"] != lemma for v in poses.values())
        },
    )
    g.dump(
        REPORT / "progress.json",
        {
            "complete": not pending,
            "levelLemmas": len(levels),
            "generatedLemmas": len(valid),
            "generatedPOS": sum(len(r["glosses"]) for r in valid.values()),
            "missing": pending,
            "rounds": rounds,
        },
    )
    rng = random.Random(64)
    with (REPORT / "spot-check.csv").open("w") as f:
        writer = csv.writer(f)
        writer.writerow(["level", "lemma", "POS", "Chinese", "English", "generated"])
        for level in g.LEVELS:
            candidates = [w for w, e in levels.items() if e["level"] == level]
            closed = [
                w
                for w in candidates
                if any(p not in ["n", "v", "a", "r"] for p in levels[w]["pos"])
            ]
            sample = closed[:10]
            sample += rng.sample(
                [w for w in candidates if w not in sample], 20 - len(sample)
            )
            for lemma in sample:
                for pos, v in entries.get(lemma, {}).items():
                    writer.writerow(
                        [
                            level,
                            lemma,
                            pos,
                            "; ".join(v["native"]),
                            "; ".join(v["target"]),
                            lemma in valid
                            and pos in [g["pos"] for g in valid[lemma]["glosses"]],
                        ]
                    )
    sys.path.insert(0, str(ROOT / "tools/data"))
    from level_pos import metadata

    metadata()
    return 1 if pending else 0
