import { describe, it, expect, vi } from "vitest";
import {
  normalizeKey,
  contentHash,
  vokaMeta,
  previewImport,
  executeImport,
  CORE_FIELDS,
} from "./import";
import { testPack } from "../data/test-pack";
import { GatewayError } from "./gateway";
describe("immutable lemma Key", () => {
  it.each([
    ["May", "en:may"],
    ["CAFE\u0301", "en:café"],
    ["Mother’s-in-law", "en:mother's-in-law"],
    ["naïve", "en:naïve"],
  ])("%s", (input, key) => expect(normalizeKey(input)).toBe(key));
});
it("hashes exact UTF-8 content with SHA-256 and records version", async () => {
  expect(await contentHash("abc")).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  const entry = testPack.entries[0],
    meta = JSON.parse(await vokaMeta(entry));
  expect(meta).toEqual({
    schema: 1,
    data: "test-2026.10",
    hashes: {
      GlossNative: await contentHash(entry.GlossNative),
      GlossTarget: await contentHash(entry.GlossTarget),
      Reading: await contentHash(entry.Reading),
    },
  });
  expect(await contentHash("é")).not.toBe(await contentHash("e\u0301"));
});
function gateway(existing = false) {
  let written = false;
  return vi.fn(async (method: string, params: any = {}): Promise<any> => {
    if (method === "noteTypes.list")
      return existing ? [{ name: "VOKA Vocabulary · English" }] : [];
    if (method === "decks.list") return [];
    if (method === "noteTypes.get")
      return { fields: CORE_FIELDS.map((name) => ({ name })) };
    if (method === "notes.search")
      return {
        ids: existing ? ["1", "2", "3"] : written ? ["4"] : [],
        nextCursor: null,
      };
    if (method === "notes.getMany")
      return {
        items: (existing
          ? ["en:achieve", "en:advice", "en:advice"]
          : ["en:achieve"]
        ).map((key, i) => ({
          index: i,
          result: { id: String(i), fields: { Key: key } },
        })),
      };
    if (method === "notes.validateMany")
      return {
        items: params.notes.map((_: unknown, index: number) => ({
          index,
          result: { valid: index === 0, issues: ["test invalid"] },
        })),
      };
    if (method === "notes.createMany") {
      written = true;
      throw new GatewayError("unreachable", "unknown");
    }
    throw new Error(method);
  });
}
it("preview is read only, reports conflicts, filters A2, and skips existing", async () => {
  const call = gateway(true),
    p = await previewImport(call);
  expect(p.counts).toEqual({ new: 10, existing: 1, conflict: 1, skipped: 2 });
  expect(
    call.mock.calls.every(([method]) =>
      [
        "noteTypes.list",
        "decks.list",
        "noteTypes.get",
        "notes.search",
        "notes.getMany",
      ].includes(method),
    ),
  ).toBe(true);
});
it("missing type preview needs no note search", async () => {
  const call = gateway(),
    p = await previewImport(call);
  expect(p.counts).toEqual({ new: 12, existing: 0, conflict: 0, skipped: 2 });
});
it("refuses mismatched field structure", async () => {
  const call = gateway(true);
  call
    .mockImplementationOnce(async () => [{ name: "VOKA Vocabulary · English" }])
    .mockImplementationOnce(async () => [])
    .mockImplementationOnce(async () => ({ fields: [{ name: "Word" }] }));
  await expect(previewImport(call)).rejects.toThrow("字段不匹配");
});
it("submits only valid notes once and resolves unknown writes by Key", async () => {
  const call = gateway(true);
  // First preview has no existing keys; subsequent read-back returns the committed note.
  call.mockImplementation(async (method: string, params: any = {}): Promise<any> => {
    if (method === "noteTypes.list")
      return [{ name: "VOKA Vocabulary · English" }];
    if (method === "decks.list") return [{ name: "VOKA::English::B1" }];
    if (method === "noteTypes.get")
      return { fields: CORE_FIELDS.map((name) => ({ name })) };
    if (method === "notes.search")
      return {
        ids: call.mock.calls.some(([m]) => m === "notes.createMany")
          ? ["4"]
          : [],
        nextCursor: null,
      };
    if (method === "notes.getMany")
      return {
        items: [{ result: { id: "4", fields: { Key: "en:achieve" } } }],
      };
    if (method === "notes.validateMany")
      return {
        items: params.notes.map((_: unknown, index: number) => ({
          index,
          result: { valid: index === 0 },
        })),
      };
    if (method === "notes.createMany")
      throw new GatewayError("unreachable", "unknown");
    throw new Error(method);
  });
  const result = await executeImport(call);
  expect(result.confirmed).toEqual(["en:achieve"]);
  expect(result.failures).toHaveLength(11);
  const writes = call.mock.calls.filter(([m]) => m === "notes.createMany");
  expect(writes).toHaveLength(1);
  expect(writes[0][1].notes).toHaveLength(1);
  expect(writes[0][1].atomic).toBe(false);
});
it("reads paginated searches and compares exact Key values", async () => {
  let page = 0;
  const call = gateway(true);
  call.mockImplementation(async (method: string, params: any = {}): Promise<any> => {
    if (method === "noteTypes.list")
      return [{ name: "VOKA Vocabulary · English" }];
    if (method === "decks.list") return [];
    if (method === "noteTypes.get")
      return { fields: CORE_FIELDS.map((name) => ({ name })) };
    if (method === "notes.search") {
      page++;
      if (page === 1) return { ids: ["1"], nextCursor: "page2" };
      expect(params.cursor).toBe("page2");
      return { ids: ["2"], nextCursor: null };
    }
    if (method === "notes.getMany")
      return {
        items: [
          {
            result: {
              id: params.ids[0],
              fields: {
                Key: params.ids[0] === "1" ? "en:Achieve" : "en:achieve",
              },
            },
          },
        ],
      };
    throw new Error(method);
  });
  expect((await previewImport(call)).counts).toEqual({
    new: 11,
    existing: 1,
    conflict: 0,
    skipped: 2,
  });
});
it("skips duplicate fixture Keys", async () => {
  const call = gateway();
  const entry = testPack.entries[0];
  expect(
    (
      await previewImport(call, undefined, [
        entry,
        { ...entry, lemma: "ACHIEVE" },
      ])
    ).counts,
  ).toEqual({ new: 1, existing: 0, conflict: 0, skipped: 1 });
});
it("a repeated import does not write or validate existing notes", async () => {
  const call = gateway(true);
  call.mockImplementation(async (method: string) => {
    if (method === "noteTypes.list")
      return [{ name: "VOKA Vocabulary · English" }];
    if (method === "decks.list") return [];
    if (method === "noteTypes.get")
      return { fields: CORE_FIELDS.map((name) => ({ name })) };
    if (method === "notes.search") return { ids: ["1"], nextCursor: null };
    if (method === "notes.getMany")
      return {
        items: testPack.entries
          .filter((e) => e.level === "B1")
          .map((e, i) => ({
            result: { id: String(i), fields: { Key: normalizeKey(e.lemma) } },
          })),
      };
    throw new Error("Unexpected write: " + method);
  });
  expect(await executeImport(call)).toEqual({ confirmed: [], failures: [] });
});
