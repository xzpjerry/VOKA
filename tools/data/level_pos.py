#!/usr/bin/env python3
"""Rebuild only level packs from pinned sources, retaining source POS."""

import csv, io, json, re, zipfile
import xml.etree.ElementTree as ET
import build

POS = dict(
    zip(
        "noun verb adjective adverb pronoun preposition determiner conjunction number interjection".split(),
        "n v a r pron prep det conj num interj".split(),
    )
)
POS.update(
    {
        "modal auxiliary": "modal",
        "be-verb": "be",
        "do-verb": "do",
        "have-verb": "have",
        "infinitive-to": "to",
    }
)


def rebuild():
    lock = json.loads((build.ROOT / "tools/data/sources.json").read_text())
    sources = {item["name"]: build.download(item) for item in lock[:2]}
    z = zipfile.ZipFile(io.BytesIO(sources["cefrj.zip"]))
    x = zipfile.ZipFile(io.BytesIO(z.read("CEFR-J Wordlist Ver1.6.xlsx")))
    ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    strings = [
        "".join(t.text or "" for t in s.findall(".//m:t", ns))
        for s in ET.fromstring(x.read("xl/sharedStrings.xml"))
    ]
    rows = []
    for row in ET.fromstring(x.read("xl/worksheets/sheet2.xml")).findall(
        ".//m:row", ns
    )[1:]:
        cells = {}
        for c in row:
            v = c.findtext("m:v", "", ns)
            cells[re.sub(r"\d", "", c.attrib["r"])] = (
                strings[int(v)] if c.attrib.get("t") == "s" and v else v
            )
        rows.append((cells.get("A", ""), cells.get("B", ""), cells.get("C", "")))
    octrows = [
        (r["headword"], r["pos"], r["CEFR"])
        for r in csv.DictReader(
            io.StringIO(sources["octanove.csv"].decode("utf-8-sig"))
        )
    ]
    sources_by_name = [("cefrj", rows), ("octanove", octrows)]
    source_pos = {}
    for name, source in sources_by_name:
        for head, pos, level in source:
            # Pinned Octanove errata: batter has note 'one who bats'; vern is a verb typo.
            if name == "octanove" and head == "batter" and not pos:
                pos = "noun"
            if pos == "vern":
                pos = "verb"
            variants = [w.strip() for w in head.split("/")]
            if (
                not variants
                or not all(build.single(v) for v in variants)
                or level not in build.LEVELS
            ):
                continue
            if pos not in POS:
                raise ValueError((head, pos, level))
            for word in variants:
                source_pos.setdefault(build.norm(word), {}).setdefault(word, set()).add(
                    POS[pos]
                )
    collisions = {}
    for lemma, headwords in source_pos.items():
        upper = {
            word: poses
            for word, poses in headwords.items()
            if len(word) >= 2 and word.isupper()
        }
        other = {word: poses for word, poses in headwords.items() if word not in upper}
        if upper and lemma in headwords:
            suppressed = set.union(*upper.values()) - set.union(*other.values())
            if suppressed:
                collisions[lemma] = {
                    "headwords": {w: sorted(p) for w, p in headwords.items()},
                    "suppressedPos": sorted(suppressed),
                }
    for name, source in sources_by_name:
        pack = json.loads((build.OUT / f"{name}.json").read_text())
        poses = {}
        for head, pos, level in source:
            if name == "octanove" and head == "batter" and not pos:
                pos = "noun"
            if pos == "vern":
                pos = "verb"
            variants = [build.norm(w.strip()) for w in head.split("/")]
            if (
                not variants
                or not all(build.single(v) for v in variants)
                or level not in build.LEVELS
            ):
                continue
            poses.setdefault(variants[0], set()).add(POS[pos])
        for lemma, entry in pack["entries"].items():
            entry[:] = entry[:2] + [sorted(poses[lemma])]
        pack["caseCollisions"] = {
            lemma: value
            for lemma, value in collisions.items()
            if lemma in pack["entries"]
        }
        pack["attribution"] = (
            pack["attribution"].split(" Source POS")[0]
            + " Source POS retained in entry tuple item 3; mapped to OEWN content POS or explicit closed-class labels. Uppercase acronym collision source POS retained in caseCollisions; acronym-only POS suppressed in learner glosses."
        )
        (build.OUT / f"{name}.json").write_text(
            json.dumps(pack, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
            + "\n"
        )


def metadata():
    import gzip

    path = build.OUT / "attributions.json"
    meta = json.loads(path.read_text())
    sizes = json.loads((build.OUT / "sizes.json").read_text())
    for name in ["cefrj", "octanove", "gloss-leveled"]:
        packpath = build.OUT / f"{name}.json"
        if not packpath.exists():
            continue
        raw = packpath.read_bytes()
        pack = json.loads(raw)
        sizes[f"{name}.json"] = {
            "raw": len(raw),
            "gzip": len(gzip.compress(raw, mtime=0)),
        }
        if name == "gloss-leveled":
            meta["packs"] = [
                p
                for p in meta["packs"]
                if p.get("prompt") != "tools/gloss/supplement-prompt.txt"
            ]
            meta["packs"].append(
                {
                    k: v
                    for k, v in pack.items()
                    if k not in ["entries", "provenance", "missing"]
                }
            )
            meta["dataVersion"] = pack["dataVersion"]
        else:
            for old in meta["packs"]:
                if old.get("source") == pack["source"]:
                    old.update({k: v for k, v in pack.items() if k != "entries"})
    path.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n")
    raw = path.read_bytes()
    sizes["attributions.json"] = {
        "raw": len(raw),
        "gzip": len(gzip.compress(raw, mtime=0)),
    }
    (build.OUT / "sizes.json").write_text(json.dumps(sizes, indent=2) + "\n")


if __name__ == "__main__":
    rebuild()
    metadata()
