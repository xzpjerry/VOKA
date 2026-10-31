import { replaceGlossCss, type GlossLanguage } from "./gloss";
import { loadData, DATA_VERSION, type Entry } from "../data";
export type { Entry } from "../data";
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
export type Call = (
  method: string,
  params?: Record<string, unknown>,
  write?: boolean,
) => Promise<any>;
export { normalizeKey } from "../key";
import { normalizeKey } from "../key";
export async function contentHash(content: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(content),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export async function vokaMeta(entry: Entry, version = DATA_VERSION) {
  const hashes = Object.fromEntries(
    await Promise.all(
      ["GlossNative", "GlossTarget", "Reading"].map(async (field) => [
        field,
        await contentHash(
          entry[field as "GlossNative" | "GlossTarget" | "Reading"],
        ),
      ]),
    ),
  );
  return JSON.stringify({ schema: 1, data: version, hashes });
}
const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
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
  // Bound search expression size: thousands of OR clauses exceed Anki parser limits.
  if (keys.length > 100) {
    const result = new Map<string, string[]>();
    for (let start = 0; start < keys.length; start += 100)
      for (const [key, ids] of await lookup(
        call,
        target,
        keys.slice(start, start + 100),
      ))
        result.set(key, ids);
    return result;
  }
  const matches = new Map(keys.map((key) => [key, [] as string[]]));
  let cursor: string | undefined;
  do {
    const result = await call("notes.search", {
      query: `note:${quote(target.noteType)} (${keys.map((k) => quote("Key:" + k)).join(" or ")})`,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    if (result.ids.length) {
      const items = [];
      for (let start = 0; start < result.ids.length; start += 100) {
        const batch = await call("notes.getMany", {
          ids: result.ids.slice(start, start + 100),
        });
        items.push(...batch.items);
      }
      const notes = { items };
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
  entries?: Entry[],
) {
  const pack = entries
    ? {
        source: "Explicit fixture",
        license: "fixture",
        version: DATA_VERSION,
        entries,
      }
    : (await loadData()).pack;
  entries = pack.entries;
  const types = await call("noteTypes.list");
  const decks = await call("decks.list");
  const typeExists = types.some(
    (t: { name: string }) => t.name === target.noteType,
  );
  const deckExists = decks.some(
    (d: { name: string }) => d.name === target.deck,
  );
  if (typeExists) await verifyType(call, target);
  const level = target.deck.split("::").at(-1);
  const selected = entries.filter((e) => e.level === level);
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
  const conflicts = rows
    .filter((r) => r.state === "conflict")
    .map((r) => r.key);
  return {
    target,
    level,
    typeExists,
    deckExists,
    source: pack.source,
    license: pack.license,
    version: pack.version,
    rows,
    conflicts,
    counts: {
      new: rows.filter((r) => r.state === "new").length,
      existing: rows.filter((r) => r.state === "existing").length,
      conflict: conflicts.length,
      skipped:
        entries.length -
        selected.length +
        rows.filter((r) => r.state === "skipped").length,
    },
  };
}
export type ImportPhase =
  | "preparing"
  | "validating"
  | "writing"
  | "reading"
  | "batch-done"
  | "cancelled"
  | "interrupted"
  | "done";
export type ImportProgress = {
  phase: ImportPhase;
  batch: number;
  batches: number;
  processed: number;
  total: number;
  created: number;
  failed: number;
  cancelled: boolean;
  interrupted: boolean;
  remaining: number;
};
export type ImportFailure = { key: string; reason: string };
export type ImportResult = {
  confirmed: string[];
  failures: ImportFailure[];
  conflicts: string[];
  cancelled: boolean;
  interrupted: boolean;
  total: number;
  processed: number;
  created: number;
  remaining: number;
};
export type ImportOptions = {
  onProgress?: (progress: ImportProgress) => void;
  signal?: AbortSignal;
  /** Logical batch size. v1 transport caps every request at maxBatchItems=100. */
  batchSize?: number;
};
/** Product target, or the test-only override read from chrome.storage.local. */
export function importTarget(
  level: string,
  override?: { noteType: string; deckPrefix: string },
): Target {
  return override
    ? { noteType: override.noteType, deck: `${override.deckPrefix}::${level}` }
    : {
        noteType: DEFAULT_TARGET.noteType,
        deck: `VOKA::English::${level}`,
      };
}
export async function executeImport(
  call: Call,
  target = DEFAULT_TARGET,
  mode: GlossLanguage = "native",
  nativeLanguage: "zh" | "en" = "zh",
  entries?: Entry[],
  options: ImportOptions = {},
): Promise<ImportResult> {
  // The v1 runtime advertises maxBatchItems=100. Keep each request bounded.
  const transport = call;
  call = async (method, params = {}, write = false) => {
    const notes = params.notes as unknown[] | undefined;
    if (
      !["notes.validateMany", "notes.createMany"].includes(method) ||
      !notes ||
      notes.length <= 100
    )
      return transport(method, params, write);
    const items = [];
    for (let start = 0; start < notes.length; start += 100) {
      const result = await transport(
        method,
        { ...params, notes: notes.slice(start, start + 100) },
        write,
      );
      items.push(
        ...result.items.map((item: { index: number }) => ({
          ...item,
          index: item.index + start,
        })),
      );
    }
    return { items };
  };
  const failures: ImportFailure[] = [];
  const confirmed: string[] = [];
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? 200));
  let total = 0;
  let batches = 0;
  let processed = 0;
  let cancelled = false;
  let interrupted = false;
  const progress = (
    phase: ImportPhase,
    batch = 0,
  ): ImportProgress => ({
    phase,
    batch,
    batches,
    processed,
    total,
    created: confirmed.length,
    failed: failures.length,
    cancelled,
    interrupted,
    remaining: Math.max(0, total - confirmed.length),
  });
  const report = (phase: ImportPhase, batch = 0) => {
    try {
      options.onProgress?.(progress(phase, batch));
    } catch {
      /* A progress consumer must never break an import. */
    }
  };
  report("preparing");
  const aborted = () => options.signal?.aborted === true;
  if (aborted()) {
    cancelled = true;
    report("cancelled");
    return {
      confirmed,
      failures,
      conflicts: [] as string[],
      cancelled,
      interrupted,
      total,
      processed,
      created: 0,
      remaining: 0,
    };
  }
  // Fresh read prevents a stale preview from overwriting anything.
  const preview = await previewImport(call, target, entries);
  const candidates = preview.rows.filter((r) => r.state === "new");
  total = candidates.length;
  batches = Math.ceil(total / batchSize);
  if (!total) {
    report("done");
    return {
      confirmed,
      failures,
      conflicts: preview.conflicts,
      cancelled,
      interrupted,
      total,
      processed,
      created: 0,
      remaining: 0,
    };
  }
  if (aborted()) {
    cancelled = true;
    report("cancelled");
    return {
      confirmed,
      failures,
      conflicts: preview.conflicts,
      cancelled,
      interrupted,
      total,
      processed,
      created: 0,
      remaining: total,
    };
  }
  async function provision(
    method: string,
    params: Record<string, unknown>,
    exists: () => Promise<boolean>,
  ) {
    try {
      await call(method, params, true);
    } catch (error) {
      if (
        !(
          error &&
          typeof error === "object" &&
          "outcome" in error &&
          error.outcome === "unknown"
        )
      )
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
        css: replaceGlossCss(css, nativeLanguage === "en" ? "target" : mode),
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
  for (let start = 0; start < total; start += batchSize) {
    if (aborted()) {
      cancelled = true;
      break;
    }
    const batch = start / batchSize + 1;
    const batchRows = candidates.slice(start, start + batchSize);
    report("validating", batch);
    const notes = await Promise.all(
      batchRows.map(async ({ key, entry }) => ({
        noteType: { name: target.noteType },
        deck: { name: target.deck },
        tags: ["voka", `voka::level::${entry.level}`],
        fields: {
          ...Object.fromEntries(CORE_FIELDS.map((f) => [f, ""])),
          Key: key,
          Word: escapeHtml(entry.lemma),
          Variants: escapeHtml(entry.Variants ?? ""),
          Reading: escapeHtml(entry.Reading),
          GlossNative:
            nativeLanguage === "en" ? "" : escapeHtml(entry.GlossNative),
          GlossTarget: escapeHtml(entry.GlossTarget),
          VokaMeta: await vokaMeta({
            ...entry,
            Reading: escapeHtml(entry.Reading),
            GlossNative:
              nativeLanguage === "en" ? "" : escapeHtml(entry.GlossNative),
            GlossTarget: escapeHtml(entry.GlossTarget),
          }),
        },
      })),
    );
    let validation: { items: any[] };
    try {
      validation = await call("notes.validateMany", { notes });
    } catch (error) {
      // Pre-validation is read-only, so these Keys are definitely not written.
      failures.push(
        ...batchRows.map((row) => ({
          key: row.key,
          reason: `预检连接中断，未写入：${String(error)}`,
        })),
      );
      processed += batchRows.length;
      interrupted = true;
      break;
    }
    const valid: number[] = [];
    batchRows.forEach((row, index) => {
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
    const validRows = valid.map((index) => batchRows[index]);
    const batchFailures = new Map<string, string>();
    let createError: unknown;
    if (valid.length) {
      report("writing", batch);
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
            batchFailures.set(
              batchRows[i].key,
              JSON.stringify(item?.error ?? "Missing create result"),
            );
        });
      } catch (error) {
        // Never resend: even an interrupted response may have committed.
        createError = error;
        for (const row of validRows)
          batchFailures.set(
            row.key,
            `写入请求未确认，正在按 Key 回读：${String(error)}`,
          );
      }
    }
    if (valid.length) {
      report("reading", batch);
      let matches: Map<string, string[]>;
      try {
        matches = await lookup(
          call,
          target,
          validRows.map((row) => row.key),
        );
      } catch (error) {
        failures.push(
          ...validRows.map((row) => ({
            key: row.key,
            reason: `回读失败，结果不确定；未重发：${String(error)}`,
          })),
        );
        processed += batchRows.length;
        interrupted = true;
        break;
      }
      for (const row of validRows) {
        const count = matches.get(row.key)?.length ?? 0;
        if (count === 1) {
          confirmed.push(row.key);
          batchFailures.delete(row.key);
        } else
          batchFailures.set(
            row.key,
            count > 1
              ? "回读发现 Key 冲突"
              : batchFailures.get(row.key)
                ? `写入未确认，回读也未找到笔记：${batchFailures.get(row.key)}`
                : "回读未找到笔记；未重发写入",
          );
      }
    }
    failures.push(
      ...validRows
        .filter((row) => batchFailures.has(row.key))
        .map((row) => ({ key: row.key, reason: batchFailures.get(row.key)! })),
    );
    processed += batchRows.length;
    report("batch-done", batch);
    if (createError) {
      interrupted = true;
      break;
    }
    if (aborted()) {
      cancelled = true;
      break;
    }
  }
  report(cancelled ? "cancelled" : interrupted ? "interrupted" : "done");
  return {
    confirmed,
    failures,
    conflicts: preview.conflicts,
    cancelled,
    interrupted,
    total,
    processed,
    created: confirmed.length,
    remaining: Math.max(0, total - confirmed.length),
  };
}
