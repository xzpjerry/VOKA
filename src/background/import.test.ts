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
    data: "en-2026.10",
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
    p = await previewImport(call, undefined, testPack.entries);
  expect(p.counts).toEqual({ new: 10, existing: 1, conflict: 1, skipped: 2 });
  expect(p.total).toBe(14);
  expect(p.selected).toBe(12);
  expect(p.conflicts).toEqual(["en:advice"]);
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
    p = await previewImport(call, undefined, testPack.entries);
  expect(p.counts).toEqual({ new: 12, existing: 0, conflict: 0, skipped: 2 });
});
it("refuses mismatched field structure", async () => {
  const call = gateway(true);
  call
    .mockImplementationOnce(async () => [{ name: "VOKA Vocabulary · English" }])
    .mockImplementationOnce(async () => [])
    .mockImplementationOnce(async () => ({ fields: [{ name: "Word" }] }));
  await expect(
    previewImport(call, undefined, testPack.entries),
  ).rejects.toThrow("字段不匹配");
});
it("submits only valid notes once and resolves unknown writes by Key", async () => {
  const call = gateway(true);
  // First preview has no existing keys; subsequent read-back returns the committed note.
  call.mockImplementation(
    async (method: string, params: any = {}): Promise<any> => {
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
    },
  );
  const result = await executeImport(
    call,
    undefined,
    undefined,
    undefined,
    testPack.entries,
  );
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
  call.mockImplementation(
    async (method: string, params: any = {}): Promise<any> => {
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
    },
  );
  expect(
    (await previewImport(call, undefined, testPack.entries)).counts,
  ).toEqual({
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
  expect(
    await executeImport(
      call,
      undefined,
      undefined,
      undefined,
      testPack.entries,
    ),
  ).toEqual({
    confirmed: [],
    failures: [],
    conflicts: [],
    cancelled: false,
    interrupted: false,
    total: 0,
    processed: 0,
    created: 0,
    remaining: 0,
  });
});
it("bounds production-size searches and writes to v1 batch limits", async () => {
  const entries = Array.from({ length: 205 }, (_, i) => ({
    ...testPack.entries[0],
    lemma: `word${i}`,
  }));
  const call = vi.fn(async (method: string, params: any = {}): Promise<any> => {
    if (method === "noteTypes.list")
      return [{ name: "VOKA Vocabulary · English" }];
    if (method === "decks.list") return [{ name: "VOKA::English::B1" }];
    if (method === "noteTypes.get")
      return { fields: CORE_FIELDS.map((name) => ({ name })) };
    if (method === "notes.search") {
      expect((params.query.match(/Key:/g) ?? []).length).toBeLessThanOrEqual(
        100,
      );
      return { ids: [], nextCursor: null };
    }
    if (method === "notes.validateMany" || method === "notes.createMany") {
      expect(params.notes.length).toBeLessThanOrEqual(100);
      return {
        items: params.notes.map((_: unknown, index: number) => ({
          index,
          result: { valid: true, noteId: String(index) },
        })),
      };
    }
    throw new Error(method);
  });
  await executeImport(call, undefined, undefined, undefined, entries);
  expect(
    call.mock.calls
      .filter(([m]) => m === "notes.validateMany")
      .map(([, p]) => p.notes.length),
  ).toEqual([100, 100, 5]);
  expect(
    call.mock.calls
      .filter(([m]) => m === "notes.createMany")
      .map(([, p]) => p.notes.length),
  ).toEqual([100, 100, 5]);
});
it.each([
  ["target", "zh"],
  ["native", "en"],
] as const)(
  "provisions current mode %s for native language %s",
  async (mode, nativeLanguage) => {
    const base = gateway();
    const call = vi.fn(
      async (method: string, params: any = {}, write = false): Promise<any> => {
        if (method === "noteTypes.create" || method === "decks.create")
          return {};
        return base(method, params);
      },
    );
    await executeImport(
      call,
      undefined,
      mode,
      nativeLanguage,
      testPack.entries,
    );
    const created = call.mock.calls.find(
      ([method]) => method === "noteTypes.create",
    )![1];
    expect(created.css).toContain(".gloss-target{display:block}");
    expect(created.css).not.toContain("\n.gloss-native{display:block}");
    const notes = call.mock.calls.find(
      ([method]) => method === "notes.validateMany",
    )![1].notes;
    if (nativeLanguage === "en") {
      expect(notes.every((n: any) => n.fields.GlossNative === "")).toBe(true);
      expect(JSON.parse(notes[0].fields.VokaMeta).hashes.GlossNative).toBe(
        await contentHash(""),
      );
    }
  },
);
it("selected level controls preview, deck and note tags", async () => {
  const base = gateway();
  const call = vi.fn(async (method: string, params: any = {}) => {
    if (["noteTypes.create", "decks.create"].includes(method)) return {};
    return base(method, params);
  });
  const entries = [{ ...testPack.entries[0], level: "A2" }];
  const target = {
    noteType: "VOKA Vocabulary · English",
    deck: "VOKA::English::A2",
  };
  const preview = await previewImport(call, target, entries);
  expect(preview.counts.new).toBe(1);
  expect(preview.rows[0].entry.level).toBe("A2");
  await executeImport(call, target, "native", "zh", entries);
  const created = call.mock.calls.find(
    ([method]) => method === "notes.createMany",
  )![1].notes[0];
  expect(created.deck.name).toBe("VOKA::English::A2");
  expect(created.tags).toEqual(["voka", "voka::level::A2"]);
});
/** In-memory v1 collection with real Key read-back semantics. */
function batchGateway() {
  const notesByKey = new Map<string, { id: string; key: string }[]>();
  const idToKey = new Map<string, string>();
  const calls: { method: string; size?: number }[] = [];
  let nextId = 1;
  let createCalls = 0;
  let failCreateCall: number | undefined;
  const call = vi.fn(async (method: string, params: any = {}) => {
    calls.push({ method, size: params.notes?.length });
    if (method === "noteTypes.list")
      return [{ name: "VOKA Vocabulary · English" }];
    if (method === "decks.list") return [{ name: "VOKA::English::B1" }];
    if (method === "noteTypes.get")
      return { fields: CORE_FIELDS.map((name) => ({ name })) };
    if (method === "notes.search") {
      const keys = [...String(params.query).matchAll(/Key:([^"\s)]+)/g)].map(
        (match) => match[1],
      );
      return {
        ids: keys.flatMap((key) =>
          (notesByKey.get(key) ?? []).map((note) => note.id),
        ),
        nextCursor: null,
      };
    }
    if (method === "notes.getMany")
      return {
        items: params.ids.map((id: string, index: number) => ({
          index,
          result: { id, fields: { Key: idToKey.get(id) } },
        })),
      };
    if (method === "notes.validateMany")
      return {
        items: params.notes.map((_: unknown, index: number) => ({
          index,
          result: { valid: true, issues: [] },
        })),
      };
    if (method === "notes.createMany") {
      createCalls++;
      if (createCalls === failCreateCall)
        throw new GatewayError("unreachable", "unknown");
      return {
        items: params.notes.map((note: any, index: number) => {
          const id = String(nextId++),
            key = note.fields.Key;
          idToKey.set(id, key);
          notesByKey.set(key, [...(notesByKey.get(key) ?? []), { id, key }]);
          return { index, result: { noteId: id, cardIds: [id] } };
        }),
      };
    }
    throw new Error(method);
  });
  return {
    call,
    calls,
    notesByKey,
    get createCalls() {
      return createCalls;
    },
    failCreateOn(callNumber: number) {
      failCreateCall = callNumber;
    },
  };
}
const batchEntries = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    ...testPack.entries[0],
    lemma: `batch${i}`,
  }));
it("runs 200-note batches as validate → create → read back before the next batch", async () => {
  const entries = batchEntries(250);
  const gateway = batchGateway();
  const progress: any[] = [];
  const result = await executeImport(
    gateway.call,
    undefined,
    "native",
    "zh",
    entries,
    { onProgress: (p) => progress.push(p) },
  );
  expect(result).toMatchObject({
    confirmed: entries.map((e) => "en:" + e.lemma),
    failures: [],
    cancelled: false,
    interrupted: false,
    total: 250,
    processed: 250,
    created: 250,
    remaining: 0,
  });
  expect(
    gateway.call.mock.calls
      .filter(([m]) => m === "notes.validateMany")
      .map(([, p]) => p.notes.length),
  ).toEqual([100, 100, 50]);
  const methods = gateway.calls.map((c) => c.method);
  const firstCreate = methods.indexOf("notes.createMany");
  const readback = methods.indexOf("notes.search", firstCreate);
  const secondBatchValidate = methods.indexOf(
    "notes.validateMany",
    firstCreate,
  );
  expect(readback).toBeGreaterThan(firstCreate);
  expect(secondBatchValidate).toBeGreaterThan(readback);
  expect(
    progress.filter((p) => p.phase === "batch-done").map((p) => p.batch),
  ).toEqual([1, 2]);
  expect(progress.at(-1)).toMatchObject({
    phase: "done",
    total: 250,
    processed: 250,
    created: 250,
    remaining: 0,
  });
});
it("cancels between batches, keeps written notes, and resumes only the remainder", async () => {
  const entries = batchEntries(250);
  const gateway = batchGateway();
  const controller = new AbortController();
  const progress: any[] = [];
  const first = await executeImport(
    gateway.call,
    undefined,
    "native",
    "zh",
    entries,
    {
      signal: controller.signal,
      onProgress: (p) => {
        progress.push(p);
        if (p.phase === "batch-done" && p.batch === 1) controller.abort();
      },
    },
  );
  expect(first).toMatchObject({
    cancelled: true,
    interrupted: false,
    created: 200,
    processed: 200,
    total: 250,
    remaining: 50,
  });
  expect(progress.at(-1)?.phase).toBe("cancelled");
  expect(
    (await previewImport(gateway.call, undefined, entries)).counts,
  ).toMatchObject({ new: 50, existing: 200, conflict: 0 });
  const writes = gateway.createCalls;
  const second = await executeImport(
    gateway.call,
    undefined,
    "native",
    "zh",
    entries,
  );
  expect(second).toMatchObject({
    cancelled: false,
    interrupted: false,
    created: 50,
    total: 50,
    remaining: 0,
  });
  expect(gateway.createCalls).toBe(writes + 1);
  expect(
    (await previewImport(gateway.call, undefined, entries)).counts,
  ).toMatchObject({ new: 0, existing: 250 });
});
it("stops on a broken connection without resending and resumes only the remainder", async () => {
  const entries = batchEntries(250);
  const gateway = batchGateway();
  gateway.failCreateOn(2);
  const first = await executeImport(
    gateway.call,
    undefined,
    "native",
    "zh",
    entries,
  );
  expect(first).toMatchObject({
    cancelled: false,
    interrupted: true,
    total: 250,
    processed: 200,
    created: 100,
    remaining: 150,
  });
  expect(first.confirmed).toHaveLength(100);
  expect(first.failures).toHaveLength(100);
  gateway.failCreateOn(0);
  expect(
    (await previewImport(gateway.call, undefined, entries)).counts,
  ).toMatchObject({ new: 150, existing: 100 });
  const second = await executeImport(
    gateway.call,
    undefined,
    "native",
    "zh",
    entries,
  );
  expect(second).toMatchObject({
    cancelled: false,
    interrupted: false,
    created: 150,
    total: 150,
    remaining: 0,
  });
  expect(
    (await previewImport(gateway.call, undefined, entries)).counts,
  ).toMatchObject({ new: 0, existing: 250 });
});
it("lists conflicts and never writes their Keys", async () => {
  const base = gateway(true);
  const call = vi.fn(
    async (method: string, params: any = {}): Promise<any> => {
      if (["noteTypes.create", "decks.create"].includes(method)) return {};
      return base(method, params);
    },
  );
  const result = await executeImport(
    call,
    undefined,
    undefined,
    undefined,
    testPack.entries,
  );
  expect(result.conflicts).toEqual(["en:advice"]);
  for (const [, params] of call.mock.calls.filter(
    ([method]) => method === "notes.createMany",
  ))
    expect(
      params.notes.map((note: any) => note.fields.Key),
    ).not.toContain("en:advice");
});
it("never calls scheduling, card moves, structure edits, or deletes", async () => {
  const entries = batchEntries(205);
  const gateway = batchGateway();
  await executeImport(
    gateway.call,
    undefined,
    "native",
    "zh",
    entries,
  );
  const forbidden = gateway.calls.filter(
    ({ method }) =>
      /^(scheduling\.|cards\.(move|delete)|notes\.delete|decks\.delete|noteTypes\.(delete|editStructure))/.test(
        method,
      ),
  );
  expect(forbidden).toEqual([]);
});
