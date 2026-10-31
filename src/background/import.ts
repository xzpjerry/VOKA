import { testPack } from "../data/test-pack";
import { questionHtml, answerHtml, css } from "../data/template";
export const CORE_FIELDS = [
  "Key",
  "Word",
  "Variants",
  "Reading",
  "GlossNative",
  "GlossTarget",
  "Context1",
  "Source1",
  "Context2",
  "Source2",
  "Context3",
  "Source3",
  "ManualStatus",
  "Audio",
  "VokaMeta",
];
export const DEFAULT_TARGET = {
  noteType: "VOKA Vocabulary · English",
  deck: "VOKA::English::B1",
};
export type Target = typeof DEFAULT_TARGET;
export type Entry = (typeof testPack.entries)[number];
export type Call = (
  method: string,
  params?: Record<string, unknown>,
  write?: boolean,
) => Promise<any>;
export const normalizeKey = (lemma: string) =>
  "en:" + lemma.toLowerCase().normalize("NFC").replace(/[‘’]/g, "'");
export async function contentHash(content: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(content),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export async function vokaMeta(entry: Entry) {
  const hashes = Object.fromEntries(
    await Promise.all(
      ["GlossNative", "GlossTarget", "Reading"].map(async (field) => [
        field,
        await contentHash(entry[field as keyof Entry]),
      ]),
    ),
  );
  return JSON.stringify({ schema: 1, data: testPack.version, hashes });
}
const quote = (value: string) =>
  '"' + value.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
async function verifyType(call: Call, target: Target) {
  const type = await call("noteTypes.get", {
    noteType: { name: target.noteType },
  });
  if (
    JSON.stringify(type.fields.map((f: { name: string }) => f.name)) !==
    JSON.stringify(CORE_FIELDS)
  )
    throw new Error(
      "笔记类型字段不匹配；需要按顺序包含 15 个核心字段。不会修改已有结构。",
    );
}
/** Read every page and compare actual field values: Anki searches are case insensitive. */
export async function lookup(call: Call, target: Target, keys: string[]) {
  const matches = new Map(keys.map((key) => [key, [] as string[]]));
  let cursor: string | undefined;
  do {
    const result = await call("notes.search", {
      query: `note:${quote(target.noteType)} (${keys.map((k) => quote("Key:" + k)).join(" or ")})`,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    if (result.ids.length) {
      const notes = await call("notes.getMany", { ids: result.ids });
      for (const item of notes.items) {
        if (item.error)
          throw new Error("无法回读笔记：" + JSON.stringify(item.error));
        const note = item.result;
        matches.get(note.fields.Key)?.push(note.id);
      }
    }
    cursor = result.nextCursor ?? undefined;
  } while (cursor);
  return matches;
}
export async function previewImport(
  call: Call,
  target = DEFAULT_TARGET,
  entries = testPack.entries,
) {
  const types = await call("noteTypes.list");
  const decks = await call("decks.list");
  const typeExists = types.some(
    (t: { name: string }) => t.name === target.noteType,
  );
  const deckExists = decks.some(
    (d: { name: string }) => d.name === target.deck,
  );
  if (typeExists) await verifyType(call, target);
  const selected = entries.filter((e) => e.level === "B1");
  const keys = selected.map((e) => normalizeKey(e.lemma));
  const matches = typeExists
    ? await lookup(call, target, keys)
    : new Map<string, string[]>();
  const seen = new Set<string>();
  const rows = selected.map((entry) => {
    const key = normalizeKey(entry.lemma),
      count = matches.get(key)?.length ?? 0;
    const state = seen.has(key)
      ? "skipped"
      : count > 1
        ? "conflict"
        : count === 1
          ? "existing"
          : "new";
    seen.add(key);
    return { key, entry, state };
  });
  return {
    target,
    typeExists,
    deckExists,
    source: testPack.source,
    license: testPack.license,
    version: testPack.version,
    rows,
    counts: {
      new: rows.filter((r) => r.state === "new").length,
      existing: rows.filter((r) => r.state === "existing").length,
      conflict: rows.filter((r) => r.state === "conflict").length,
      skipped:
        entries.length -
        selected.length +
        rows.filter((r) => r.state === "skipped").length,
    },
  };
}
export async function executeImport(call: Call, target = DEFAULT_TARGET) {
  // Fresh read prevents a stale preview from overwriting anything.
  const preview = await previewImport(call, target);
  const failures: { key: string; reason: string }[] = [];
  const candidates = preview.rows.filter((r) => r.state === "new");
  if (!candidates.length) return { confirmed: [] as string[], failures };
  async function provision(
    method: string,
    params: Record<string, unknown>,
    exists: () => Promise<boolean>,
  ) {
    try {
      await call(method, params, true);
    } catch (error) {
      if (!(
        error &&
        typeof error === "object" &&
        "outcome" in error &&
        error.outcome === "unknown"
      ))
        throw error;
      if (!(await exists()))
        throw new Error("写入结果不确定；已回读，未重发。请稍后重新预览。");
    }
  }
  if (!preview.typeExists)
    await provision(
      "noteTypes.create",
      {
        name: target.noteType,
        fields: CORE_FIELDS.map((name) => ({ name })),
        templates: [{ name: "词卡", questionHtml, answerHtml }],
        css,
        sortField: "Word",
      },
      async () =>
        (await call("noteTypes.list")).some(
          (t: { name: string }) => t.name === target.noteType,
        ),
    );
  await verifyType(call, target);
  if (!preview.deckExists)
    await provision("decks.create", { name: target.deck }, async () =>
      (await call("decks.list")).some(
        (d: { name: string }) => d.name === target.deck,
      ),
    );
  const notes = await Promise.all(
    candidates.map(async ({ key, entry }) => ({
      noteType: { name: target.noteType },
      deck: { name: target.deck },
      tags: ["voka", "voka::level::B1"],
      fields: {
        ...Object.fromEntries(CORE_FIELDS.map((f) => [f, ""])),
        Key: key,
        Word: entry.lemma,
        Reading: entry.Reading,
        GlossNative: entry.GlossNative,
        GlossTarget: entry.GlossTarget,
        VokaMeta: await vokaMeta(entry),
      },
    })),
  );
  const validation = await call("notes.validateMany", { notes });
  const valid: number[] = [];
  candidates.forEach((row, index) => {
    const item = validation.items.find(
      (i: { index: number }) => i.index === index,
    );
    if (item?.result?.valid === true) valid.push(index);
    else
      failures.push({
        key: row.key,
        reason: JSON.stringify(
          item?.error ?? item?.result?.issues ?? "Missing validation result",
        ),
      });
  });
  let uncertain = false;
  if (valid.length) {
    try {
      const result = await call(
        "notes.createMany",
        { notes: valid.map((i) => notes[i]), atomic: false },
        true,
      );
      valid.forEach((i, index) => {
        const item = result.items.find(
          (r: { index: number }) => r.index === index,
        );
        if (item?.error || !item?.result)
          failures.push({
            key: candidates[i].key,
            reason: JSON.stringify(item?.error ?? "Missing create result"),
          });
      });
    } catch (error) {
      uncertain = true; // Never resend: even an interrupted response may have committed.
      failures.push(
        ...valid.map((i) => ({
          key: candidates[i].key,
          reason: `写入请求未确认，正在按 Key 回读：${String(error)}`,
        })),
      );
    }
  }
  const confirmed: string[] = [];
  if (valid.length) {
    try {
      const matches = await lookup(
        call,
        target,
        valid.map((i) => candidates[i].key),
      );
      for (const i of valid) {
        const key = candidates[i].key,
          count = matches.get(key)?.length ?? 0;
        if (count === 1) {
          confirmed.push(key);
          if (uncertain) {
            const failure = failures.findIndex((f) => f.key === key);
            if (failure >= 0) failures.splice(failure, 1);
          }
        } else
          failures.push({
            key,
            reason:
              count > 1 ? "回读发现 Key 冲突" : "回读未找到笔记；未重发写入",
          });
      }
    } catch (error) {
      failures.push(
        ...valid.map((i) => ({
          key: candidates[i].key,
          reason: `回读失败，结果不确定；未重发：${String(error)}`,
        })),
      );
    }
  }
  return { confirmed, failures };
}
