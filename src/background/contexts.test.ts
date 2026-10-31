import { it, expect, vi } from "vitest";
import { cardContext } from "./contexts";
import { CORE_FIELDS } from "./import";
import { sentenceAt } from "../contexts";
const config = {
  nativeLanguage: "zh",
  glossLanguage: "native",
  targetLevel: "B1",
  showAdvanced: false,
  hoverScope: "highlighted",
} as const;
it("reads fresh fields, merges only context changes, and reads back every update", async () => {
  const fields: Record<string, string> = {
    Key: "en:apple",
    Word: "apple",
    GlossNative: "User edited gloss",
    Context1: "User edited context text.",
    Source1: "Anki edit",
  };
  const call = vi.fn(async (method: string, params: any = {}) => {
    if (method === "notes.search") return { ids: ["1"] };
    if (method === "notes.getMany")
      return { items: [{ result: { id: "1", fields: { ...fields } } }] };
    if (method === "notes.update") {
      Object.assign(fields, params.patch.fields);
      return {};
    }
    throw new Error(method);
  });
  await cardContext(
    call,
    {
      key: "en:apple",
      action: "save",
      ...sentenceAt("I ate an apple today.", 9, 5),
      url: "https://example.com/private",
      title: "Page",
    },
    config,
  );
  expect(fields.Context2).toBe("User edited context text.");
  expect(fields.GlossNative).toBe("User edited gloss");
  const writes = call.mock.calls.filter(([m]) => m === "notes.update");
  expect(writes).toHaveLength(1);
  expect(writes[0][1].patch.fields).not.toHaveProperty("GlossNative");
  expect(call.mock.calls.at(-1)?.[0]).toBe("notes.getMany");
  expect(fields.Source1).not.toContain("/private");
});
it.each([
  ["apple", "A2"],
  ["vokacontextfixture", "Unleveled"],
])(
  "manual %s add creates just one note in %s with validate/create/readback",
  async (lemma, deck) => {
    let fields: Record<string, string> | undefined;
    const call = vi.fn(async (method: string, params: any = {}) => {
      if (method === "notes.search") return { ids: fields ? ["1"] : [] };
      if (method === "notes.getMany")
        return { items: [{ result: { id: "1", fields } }] };
      if (method === "noteTypes.list")
        return [{ name: "VOKA Vocabulary · English" }];
      if (method === "noteTypes.get")
        return { fields: CORE_FIELDS.map((name) => ({ name })) };
      if (method === "decks.list") return [];
      if (method === "decks.create") return {};
      if (method === "notes.validateMany")
        return { items: [{ result: { valid: true } }] };
      if (method === "notes.createMany") {
        fields = params.notes[0].fields;
        return { items: [{ result: { id: "1" } }] };
      }
      throw new Error(method);
    });
    await cardContext(
      call,
      {
        key: "en:" + lemma,
        action: "save",
        ...sentenceAt(`I found a ${lemma} today.`, 10, lemma.length),
        url: "https://example.com/",
        title: "Page",
      },
      config,
    );
    const notes = call.mock.calls.find(([m]) => m === "notes.createMany")![1]
      .notes;
    expect(notes).toHaveLength(1);
    expect(notes[0].deck.name).toBe("VOKA::English::" + deck);
    if (deck === "A2") expect(notes[0].tags).toContain("voka::level::A2");
    else expect(notes[0].tags).toEqual(["voka"]);
    expect(fields!.Context1).toContain(`<b>${lemma}</b>`);
    expect(
      call.mock.calls.findIndex(([m]) => m === "notes.validateMany"),
    ).toBeLessThan(
      call.mock.calls.findIndex(([m]) => m === "notes.createMany"),
    );
  },
);
it("never retries an update whose response was lost, and confirms it by readback", async () => {
  const fields: Record<string, string> = { Key: "en:apple" };
  const call = vi.fn(async (method: string, params: any = {}) => {
    if (method === "notes.search") return { ids: ["1"] };
    if (method === "notes.getMany")
      return { items: [{ result: { id: "1", fields: { ...fields } } }] };
    if (method === "notes.update") {
      Object.assign(fields, params.patch.fields);
      throw new Error("response lost");
    }
    throw new Error(method);
  });
  const result = await cardContext(
    call,
    {
      key: "en:apple",
      action: "save",
      ...sentenceAt("I ate an apple today.", 9, 5),
      url: "https://example.com",
      title: "Page",
    },
    config,
  );
  expect(result.contexts).toHaveLength(1);
  expect(call.mock.calls.filter(([m]) => m === "notes.update")).toHaveLength(1);
});
it("rejects stale replacement hashes instead of erasing an Anki edit", async () => {
  const fields = {
    Key: "en:apple",
    Context1: "User edited this one.",
    Context2: "Another current sentence.",
    Context3: "A third current sentence.",
  };
  const call = vi.fn(async (method: string) => {
    if (method === "notes.search") return { ids: ["1"] };
    if (method === "notes.getMany")
      return { items: [{ result: { id: "1", fields } }] };
    throw new Error(method);
  });
  await expect(
    cardContext(
      call,
      {
        key: "en:apple",
        action: "save",
        ...sentenceAt("I ate an apple today.", 9, 5),
        replace: "stale-hash",
        url: "https://example.com",
      },
      config,
    ),
  ).rejects.toThrow("替换一条");
  expect(call.mock.calls.some(([m]) => m === "notes.update")).toBe(false);
});
it("refuses conflicting Keys without performing a write", async () => {
  const call = vi.fn(async (method: string) => {
    if (method === "notes.search") return { ids: ["1", "2"] };
    if (method === "notes.getMany")
      return {
        items: [1, 2].map((id) => ({
          result: { id: String(id), fields: { Key: "en:apple" } },
        })),
      };
    throw new Error(method);
  });
  await expect(
    cardContext(call, { key: "en:apple", action: "read" }, config),
  ).rejects.toThrow("多条笔记");
});
