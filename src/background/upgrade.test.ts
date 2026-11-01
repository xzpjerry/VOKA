import { describe, it, expect } from "vitest";
import { executeUpgrade, previewUpgrade, generatedFields } from "./upgrade";
import { vokaMeta, contentHash } from "./import";
import { DATA_VERSION, type Entry } from "../data";
const old: Entry = {
  lemma: "test",
  level: "B1",
  GlossNative: "旧",
  GlossTarget: "old",
  Reading: "old IPA",
};
const next = {
  ...old,
  GlossNative: "新",
  GlossTarget: "new & better",
  Reading: "new IPA",
};
async function fixture(count = 2) {
  const notes = await Promise.all(
    Array.from({ length: count }, async (_, i) => ({
      id: String(i),
      tags: ["voka", "custom"],
      fields: {
        Key: `en:test${i}`,
        ...old,
        Context1: "keep context",
        Source1: "source",
        ManualStatus: "known",
        Audio: "audio",
        VokaMeta: JSON.stringify({
          ...JSON.parse(await vokaMeta(old, "old")),
          pin: "pinned",
          hashes: {
            ...JSON.parse(await vokaMeta(old)).hashes,
            pinned: "other hash",
          },
          extra: { preserve: true },
        }),
      },
    })),
  );
  const writes: any[] = [];
  let failId = "",
    uncertain = false;
  const call = async (
    method: string,
    params: any = {},
    write = false,
  ): Promise<any> => {
    if (write) writes.push({ method, params });
    if (method === "notes.search") return { ids: notes.map((n) => n.id) };
    if (method === "notes.getMany") {
      expect(params.ids.length).toBeLessThanOrEqual(100);
      return {
        items: params.ids.map((id: string) => ({
          result: structuredClone(notes.find((n) => n.id === id)),
        })),
      };
    }
    if (method === "notes.update") {
      if (params.id === failId) throw new Error("rejected");
      Object.assign(
        notes.find((n) => n.id === params.id)!.fields,
        params.patch.fields,
      );
      if (uncertain) throw new Error("lost response");
      return {};
    }
    throw new Error(method);
  };
  return {
    notes,
    writes,
    call,
    fail: (id: string) => {
      failId = id;
    },
    uncertain: () => {
      uncertain = true;
    },
  };
}
describe("gloss upgrades", () => {
  it("T-29 preview is read only, defaults edited notes to keep, preserves unrelated fields and metadata", async () => {
    const f = await fixture();
    f.notes[1].fields.GlossNative = "my meaning";
    const snapshot = structuredClone(f.notes);
    const p = await previewUpgrade(f.call, "zh", () => next);
    expect(p.rows.map((r) => r.edited)).toEqual([false, true]);
    expect(f.notes).toEqual(snapshot);
    expect(f.writes).toEqual([]);
    const r = await executeUpgrade(
      f.call,
      p,
      p.rows.filter((r) => !r.edited).map((r) => r.id),
    );
    expect(r.results[0].status).toBe("updated");
    expect(f.notes[1]).toEqual(snapshot[1]);
    expect(Object.keys(f.writes[0].params.patch.fields).sort()).toEqual(
      [...generatedFields, "VokaMeta"].sort(),
    );
    const meta = JSON.parse(f.notes[0].fields.VokaMeta);
    expect(meta).toMatchObject({
      data: DATA_VERSION,
      pin: "pinned",
      extra: { preserve: true },
      hashes: { pinned: "other hash" },
    });
    for (const key of generatedFields)
      expect(meta.hashes[key]).toBe(await contentHash(f.notes[0].fields[key]));
    expect(f.notes[0].fields.GlossTarget).toBe("new &amp; better");
    const rest = (n: (typeof f.notes)[0]) =>
      Object.fromEntries(
        Object.entries(n.fields).filter(
          ([k]) => ![...generatedFields, "VokaMeta"].includes(k),
        ),
      );
    expect(rest(f.notes[0])).toEqual(rest(snapshot[0]));
    const rerun = await previewUpgrade(f.call, "zh", () => next);
    expect(rerun.rows.map((r) => r.id)).toEqual(["1"]);
    await executeUpgrade(f.call, rerun, ["1"]);
    expect((await previewUpgrade(f.call, "zh", () => next)).rows).toHaveLength(
      0,
    );
  });
  it("rejects stale confirmations and malformed metadata, leaving all fields untouched", async () => {
    const f = await fixture();
    f.notes[1].fields.VokaMeta = "bad";
    const p = await previewUpgrade(f.call, "zh", () => next);
    expect(p.failures).toHaveLength(1);
    f.notes[0].fields.Reading = "edited after preview";
    const result = await executeUpgrade(f.call, p, ["0"]);
    expect(result.results[0].status).toBe("failed");
    expect(f.writes).toHaveLength(0);
  });
  it("batches large reads, tolerates partial failures, resolves uncertain writes without retry", async () => {
    const f = await fixture(202);
    f.fail("1");
    f.uncertain();
    const p = await previewUpgrade(f.call, "zh", () => next);
    const progress: number[] = [];
    const r = await executeUpgrade(
      f.call,
      p,
      p.rows.map((r) => r.id),
      (p) => progress.push(p.processed),
    );
    expect(r.results.filter((r) => r.status === "updated")).toHaveLength(201);
    expect(f.writes).toHaveLength(202);
    expect(progress.at(-1)).toBe(202);
  });
  it("respects native English and ignores equal output, current versions, and untagged notes", async () => {
    const f = await fixture(3);
    f.notes[0].fields.VokaMeta = await vokaMeta(old);
    f.notes[1].tags = [];
    expect((await previewUpgrade(f.call, "zh", () => old)).rows).toHaveLength(
      0,
    );
    const p = await previewUpgrade(f.call, "en", () => next);
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0].next.GlossNative).toBe("");
  });
});
