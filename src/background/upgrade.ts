import { readUpgradeKept } from "../upgrade-kept";
import { DATA_VERSION, loadData, type Entry } from "../data";
import { contentHash, type Call } from "./import";

export const generatedFields = [
  "GlossNative",
  "GlossTarget",
  "Reading",
] as const;
export type Generated = Record<(typeof generatedFields)[number], string>;
export type UpgradeRow = {
  id: string;
  key: string;
  edited: boolean;
  current: Generated;
  next: Generated;
  /** The exact metadata previewed; used to reject stale confirmations. */
  meta: string;
};
export type UpgradePreview = {
  version: string;
  rows: UpgradeRow[];
  failures: { id: string; reason: string }[];
};
const html = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const pick = (fields: Record<string, string>): Generated =>
  Object.fromEntries(generatedFields.map((f) => [f, fields[f]])) as Generated;
function metadata(raw: string) {
  let meta;
  try {
    meta = JSON.parse(raw);
  } catch {
    throw new Error("升级记录不完整，已跳过；请检查笔记");
  }
  if (
    !meta ||
    typeof meta !== "object" ||
    Array.isArray(meta) ||
    meta.schema !== 1 ||
    !meta.hashes ||
    typeof meta.hashes !== "object" ||
    Array.isArray(meta.hashes)
  )
    throw new Error("VokaMeta 无效；未修改");
  return meta;
}
/** Collection-wide; never writes to Anki. May prune obsolete local keep decisions. */
export async function previewUpgrade(
  call: Call,
  nativeLanguage: "zh" | "en" = "zh",
  resolve?: (key: string) => Entry,
): Promise<UpgradePreview> {
  const kept = await readUpgradeKept();
  const matching = new Set<string>();
  let complete = true;
  const entry = resolve ?? (await loadData()).lookupEntry;
  const preview: UpgradePreview = {
    version: DATA_VERSION,
    rows: [],
    failures: [],
  };
  let cursor: string | undefined;
  do {
    const page = await call("notes.search", {
      query: "tag:voka Key:en:*",
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    for (let start = 0; start < page.ids.length; start += 100) {
      const batch = await call("notes.getMany", {
        ids: page.ids.slice(start, start + 100),
      });
      for (const item of batch.items) {
        const note = item.result;
        try {
          if (item.error || !note) {
            complete = false;
            throw new Error(JSON.stringify(item.error));
          }
          const fields = note.fields;
          if (!fields.Key?.startsWith("en:") || !note.tags?.includes("voka"))
            continue;
          matching.add(note.id);
          if (kept[note.id] === DATA_VERSION) continue;
          const meta = metadata(fields.VokaMeta);
          if (meta.data === DATA_VERSION) continue;
          if (!generatedFields.every((f) => typeof fields[f] === "string"))
            throw new Error("生成字段缺失");
          const current = pick(fields),
            output = entry(fields.Key);
          const next: Generated = {
            GlossNative:
              nativeLanguage === "en" ? "" : html(output.GlossNative),
            GlossTarget: html(output.GlossTarget),
            Reading: html(output.Reading),
          };
          if (generatedFields.every((f) => current[f] === next[f])) continue;
          const hashes = await Promise.all(
            generatedFields.map((f) => contentHash(current[f])),
          );
          preview.rows.push({
            id: note.id,
            key: fields.Key,
            current,
            next,
            meta: fields.VokaMeta,
            edited: generatedFields.some(
              (f, i) => hashes[i] !== meta.hashes[f],
            ),
          });
        } catch (error) {
          preview.failures.push({
            id: note?.id ?? String(item.index),
            reason: String(error),
          });
        }
      }
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  // Only prune after a complete scan; failed reads must not erase decisions.
  const pruned = Object.fromEntries(Object.entries(kept).filter(([id, version]) =>
    version === DATA_VERSION && (!complete || matching.has(id)),
  ));
  if (JSON.stringify(pruned) !== JSON.stringify(kept))
    await chrome.storage.local.set({ upgradeKept: pruned });
  return preview;
}
export type UpgradeResult = {
  results: {
    id: string;
    key: string;
    status: "updated" | "failed";
    reason?: string;
  }[];
  total: number;
  processed: number;
};
/** Confirmed server-owned preview only. Re-read before patching; never retry a write. */
export async function executeUpgrade(
  call: Call,
  preview: UpgradePreview,
  selected: string[],
  onProgress?: (p: UpgradeResult) => void,
): Promise<UpgradeResult> {
  if (preview.version !== DATA_VERSION)
    throw new Error("数据包已变更，请重新预览");
  const selectedIds = new Set(selected);
  const kept = await readUpgradeKept();
  for (const row of preview.rows)
    if (!selectedIds.has(row.id)) kept[row.id] = preview.version;
  await chrome.storage.local.set({ upgradeKept: kept });
  const rows = preview.rows.filter((r) => selectedIds.has(r.id));
  const result: UpgradeResult = {
    results: [],
    total: rows.length,
    processed: 0,
  };
  for (let start = 0; start < rows.length; start += 100) {
    const batch = rows.slice(start, start + 100);
    let items: any[];
    try {
      items = (await call("notes.getMany", { ids: batch.map((r) => r.id) }))
        .items;
    } catch (error) {
      items = [];
    }
    for (const row of batch) {
      try {
        const note = items.find((i) => i.result?.id === row.id)?.result;
        if (
          !note ||
          note.fields.Key !== row.key ||
          !note.tags?.includes("voka")
        )
          throw new Error("无法确认笔记身份，请重新预览");
        const fields = note.fields;
        if (
          fields.VokaMeta !== row.meta ||
          generatedFields.some((f) => fields[f] !== row.current[f])
        )
          throw new Error("预览后笔记已改变，请重新预览");
        const meta = metadata(fields.VokaMeta);
        const hashes = Object.fromEntries(
          await Promise.all(
            generatedFields.map(async (f) => [
              f,
              await contentHash(row.next[f]),
            ]),
          ),
        );
        const patch = {
          ...row.next,
          VokaMeta: JSON.stringify({
            ...meta,
            data: DATA_VERSION,
            hashes: { ...meta.hashes, ...hashes },
          }),
        };
        let failure: unknown;
        try {
          await call(
            "notes.update",
            { id: row.id, patch: { fields: patch } },
            true,
          );
        } catch (error) {
          failure = error;
        }
        // Resolve even uncertain writes by Key, checking the exact ID and all patched bytes.
        const found = await call("notes.search", {
          query: `tag:voka "Key:${row.key.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`,
          limit: 1000,
        });
        if (!found.ids.includes(row.id))
          throw new Error("回读找不到 Key；未重发");
        const read = (await call("notes.getMany", { ids: [row.id] })).items[0]
          ?.result;
        if (
          read?.fields.Key !== row.key ||
          Object.entries(patch).some(([f, v]) => read.fields[f] !== v)
        )
          throw new Error(
            "回读未确认；未重发：" + String(failure ?? "字段不匹配"),
          );
        result.results.push({ id: row.id, key: row.key, status: "updated" });
      } catch (error) {
        result.results.push({
          id: row.id,
          key: row.key,
          status: "failed",
          reason: String(error),
        });
      }
      result.processed++;
      try {
        onProgress?.({
          total: result.total,
          processed: result.processed,
          results: [result.results[result.results.length - 1]],
        });
      } catch {
        /* UI cannot abort safe writes. */
      }
    }
  }
  return result;
}
