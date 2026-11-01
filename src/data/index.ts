/** Offline packs are separate files with independent licensing. Call loadData once before lookup. */
export const DATA_VERSION = "en-2026.11.1";
export const LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"] as const;
export type Level = (typeof LEVELS)[number];
export interface Entry {
  lemma: string;
  level: string;
  Variants?: string;
  Reading: string;
  GlossTarget: string;
  GlossNative: string;
}
export interface Pack {
  source: string;
  license: string;
  version: string;
  entries: Entry[];
}
export const normalizeLemma = (word: string) =>
  word.toLowerCase().normalize("NFC").replace(/[‘’]/g, "'");
type LevelEntries = Record<string, [Level, string[], string[]?]>;
type Dictionary = Record<string, Record<string, string[]>>;
export type ReadPack = (name: string) => Promise<any>;
const readPack: ReadPack = async (name) => {
  const response = await fetch(chrome.runtime.getURL(`data/${name}.json`));
  if (!response.ok)
    throw new Error(`Cannot load data pack ${name}: ${response.status}`);
  return response.json();
};
const labels: Record<string, string> = {
  n: "n.",
  v: "v.",
  a: "adj.",
  r: "adv.",
  s: "adj.",
  pron: "pron.",
  prep: "prep.",
  det: "det.",
  conj: "conj.",
  num: "num.",
  modal: "modal",
  be: "be",
  do: "aux. do",
  have: "aux. have",
  interj: "interj.",
  to: "inf. to",
};
const format = (groups: Record<string, string[]>) =>
  Object.entries(groups)
    .map(([pos, values]) => `${labels[pos] ?? pos} ${values.join("; ")}`)
    .join(" · ");

export function createData(packs: any[]) {
  const [cefr, octa, oewn, cmu, fallback, morphology, native, leveled] = packs;
  const levels = new Map<
    string,
    { level: Level; variants: string[]; pos: string[] }
  >();
  for (const pack of [cefr, octa]) {
    for (const [lemma, [level, variants, pos]] of Object.entries(
      pack.entries as LevelEntries,
    )) {
      const previous = levels.get(lemma);
      levels.set(lemma, {
        level:
          previous && LEVELS.indexOf(previous.level) < LEVELS.indexOf(level)
            ? previous.level
            : level,
        variants: [...new Set([...(previous?.variants ?? []), ...variants])],
        pos: [...new Set([...(previous?.pos ?? []), ...(pos ?? [])])],
      });
    }
  }
  // Preserve raw source POS while hiding acronym-only POS for case-colliding Keys.
  for (const pack of [cefr, octa]) {
    for (const [lemma, collision] of Object.entries(
      pack.caseCollisions ?? {},
    ) as [string, { suppressedPos: string[] }][]) {
      const info = levels.get(lemma);
      if (info)
        info.pos = info.pos.filter(
          (pos) => !collision.suppressedPos.includes(pos),
        );
    }
  }
  const aliases = new Map<string, string>();
  for (const [lemma, { variants }] of levels)
    for (const variant of variants) aliases.set(variant, lemma);
  // A spelling can also appear as a standalone headword in either source.
  // Fold it into the first spelling rather than emitting a second immutable Key.
  for (const [variant, lemma] of aliases) {
    if (variant === lemma) continue;
    const standalone = levels.get(variant),
      primary = levels.get(lemma);
    if (standalone && primary) {
      if (LEVELS.indexOf(standalone.level) < LEVELS.indexOf(primary.level))
        primary.level = standalone.level;
      primary.variants = [
        ...new Set([...primary.variants, variant, ...standalone.variants]),
      ];
      primary.pos = [...new Set([...primary.pos, ...standalone.pos])];
      levels.delete(variant);
    }
  }
  const canonical = (value: string) => {
    const lemma = normalizeLemma(value.replace(/^en:/, ""));
    return aliases.get(lemma) ?? lemma;
  };
  const dictionary = oewn.entries as Dictionary;
  const nativeGlosses = (native?.entries ?? {}) as Dictionary;
  const hasDictionary = (lemma: string) => Object.hasOwn(dictionary, lemma);
  function lookupEntry(
    key: string,
  ): Entry & { dictionaryStatus: "found" | "missing"; message: string } {
    const lemma = canonical(key);
    const info = levels.get(lemma);
    const spellings = [lemma, ...(info?.variants ?? [])];
    const glosses: Record<string, string[]> = {};
    const nativeByPos: Record<string, string[]> = {};
    for (const word of spellings) {
      for (const [pos, definitions] of Object.entries(dictionary[word] ?? {})) {
        if (
          info?.pos.length &&
          !info.pos.includes(pos.split("-")[0].replace(/^s$/, "a"))
        )
          continue;
        glosses[pos] = [
          ...new Set([...(glosses[pos] ?? []), ...definitions]),
        ].slice(0, 2);
      }
      for (const [pos, senses] of Object.entries(nativeGlosses[word] ?? {})) {
        if (info?.pos.length && !info.pos.includes(pos)) continue;
        nativeByPos[pos] = [
          ...new Set([...(nativeByPos[pos] ?? []), ...senses]),
        ].slice(0, 3);
      }
    }
    if (info) {
      for (const [pos, value] of Object.entries(
        leveled?.entries?.[lemma] ?? {},
      ) as [string, { native: string[]; target: string[] }][]) {
        if (!info.pos.includes(pos)) continue;
        nativeByPos[pos] = value.native;
        for (const existing of Object.keys(glosses))
          if (existing.split("-")[0] === pos) delete glosses[existing];
        glosses[pos] = value.target;
      }
    }
    let reading =
      spellings
        .map((w) => cmu.entries[w] as string | undefined)
        .find(Boolean) ?? "";
    if (!reading) {
      const pronunciations: Record<string, string[]> = {};
      for (const word of spellings)
        for (const [pos, value] of Object.entries(fallback.entries[word] ?? {}))
          pronunciations[pos] ??= [`/${value}/`];
      reading = format(pronunciations);
    }
    const found = info
      ? Object.keys(glosses).length > 0
      : spellings.some(hasDictionary);
    return {
      lemma,
      level: info?.level ?? "",
      Variants: info?.variants.join("; ") ?? "",
      Reading: reading,
      GlossNative: format(nativeByPos),
      GlossTarget: format(glosses),
      dictionaryStatus: found ? "found" : "missing",
      message: found ? "" : "词典没有",
    };
  }
  function lemmaCandidates(form: string): string[] {
    const word = normalizeLemma(form);
    const candidates = new Set<string>();
    const add = (candidate: string, pos?: string) => {
      const lemma = canonical(candidate);
      if (
        levels.has(lemma) ||
        (pos ? dictionary[lemma]?.[pos] : hasDictionary(lemma))
      )
        candidates.add(lemma);
    };
    add(word);
    for (const pos of ["n", "v", "a", "r"]) {
      const exceptions = morphology.entries[pos]?.[word] as
        string[] | undefined;
      if (exceptions) exceptions.forEach((lemma) => add(lemma, pos));
      else
        for (const [suffix, replacement] of (morphology.rules[pos] ??
          []) as string[][])
          if (word.endsWith(suffix))
            add(word.slice(0, -suffix.length) + replacement, pos);
    }
    return [...candidates].sort((a, b) => {
      const rank = (lemma: string) =>
        levels.has(lemma) ? LEVELS.indexOf(levels.get(lemma)!.level) : 6;
      return (
        rank(a) - rank(b) ||
        Number(b === canonical(word)) - Number(a === canonical(word)) ||
        a.localeCompare(b)
      );
    });
  }
  const pack: Pack = {
    source:
      "CEFR-J Wordlist 1.6 (Tono Laboratory, TUFS); Octanove C1/C2 1.0; Open English WordNet 2025; CMUdict",
    license:
      "Separate data licenses: CEFR-J attribution terms; CC BY-SA 4.0 (Octanove); CC BY 4.0 (OEWN); CMU BSD; Princeton WordNet notice",
    version: DATA_VERSION,
    entries: [...levels.keys()].sort().map(lookupEntry),
  };
  return { pack, lookupEntry, lemmaCandidates };
}
export type Data = ReturnType<typeof createData>;
let loaded: Promise<Data> | undefined;
export function loadData(read: ReadPack = readPack): Promise<Data> {
  return (loaded ??= Promise.all(
    [
      "cefrj",
      "octanove",
      "oewn",
      "readings",
      "oewn-readings",
      "morphology",
      "gloss-zh",
      "gloss-leveled",
    ].map(read),
  )
    .then(createData)
    .catch((error) => {
      loaded = undefined;
      throw error;
    }));
}
export async function lookupEntry(key: string) {
  return (await loadData()).lookupEntry(key);
}
export async function lemmaCandidates(form: string) {
  return (await loadData()).lemmaCandidates(form);
}
