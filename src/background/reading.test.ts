import { it, expect, vi } from "vitest";
import { pageStates } from "./reading";
it("deduplicates page keys, reads paginated notes/cards and exact Keys, never writes", async () => {
  const call = vi.fn(async (method: string, params: any) => {
    if (method === "notes.search")
      return params.cursor
        ? { ids: ["2", "3", "4"] }
        : { ids: ["1"], nextCursor: "next" };
    if (method === "notes.getMany")
      return {
        items: params.ids.map((id: string) => ({
          result: {
            id,
            fields: {
              Key:
                id === "1"
                  ? "en:achieve"
                  : id === "2"
                    ? "En:ACHIEVE"
                    : "en:advice",
              ManualStatus: "",
            },
            cardIds: [id],
            tags: ["voka::level::B1"],
          },
        })),
      };
    if (method === "cards.search")
      return params.query.includes("is:due") ? { ids: ["1"] } : { ids: ["1"] };
    if (method === "cards.getMany")
      return {
        items: [
          {
            result: {
              id: "1",
              scheduling: { type: "review", queue: "review", intervalDays: 21 },
            },
          },
        ],
      };
    if (method === "scheduling.getDue") return { dueNow: true, available: true };
    throw new Error(method);
  });
  const result = await pageStates(call, [
    "en:achieve",
    "en:achieve",
    "en:advice",
  ]);
  expect(result["en:achieve"].cards[0].intervalDays).toBe(21);
  expect(result["en:achieve"].cards[0]).toMatchObject({
    cardId: "1",
    dueToday: true,
  });
  expect(result["en:achieve"].level).toBe("B1");
  expect(result["en:advice"]).toBeUndefined(); // duplicates are conflicts
  expect(result["En:ACHIEVE"]).toBeUndefined();
  expect(call.mock.calls[0][1].query.match(/Key:en:achieve/g)).toHaveLength(1);
  expect(
    call.mock.calls.every((c) =>
      [
        "notes.search",
        "notes.getMany",
        "cards.search",
        "cards.getMany",
        "scheduling.getDue",
      ].includes(c[0]),
    ),
  ).toBe(true);
  const dueQuery = call.mock.calls.find(
    ([method, params]) => method === "cards.search" && params.query.includes("is:due"),
  )?.[1].query;
  expect(dueQuery).toContain('note:"VOKA Vocabulary · English" is:due');
  expect(dueQuery).toContain('"Key:en:achieve"');
});
it("paginates due candidates and skips getDue for cards outside that search", async () => {
  const call = vi.fn(async (method: string, params: any) => {
    if (method === "notes.search") return { ids: ["1"] };
    if (method === "notes.getMany")
      return {
        items: [
          {
            result: {
              id: "1",
              fields: { Key: "en:achieve" },
              cardIds: ["1", "2", "3"],
              tags: [],
            },
          },
        ],
      };
    if (method === "cards.search") {
      if (!params.query.includes("is:due")) return { ids: ["1", "2", "3"] };
      return params.cursor
        ? { ids: ["2"] }
        : { ids: ["1"], nextCursor: "due-next" };
    }
    if (method === "cards.getMany")
      return {
        items: params.ids.map((id: string) => ({
          result: {
            id,
            scheduling: { type: "review", queue: "review", intervalDays: 2 },
          },
        })),
      };
    if (method === "scheduling.getDue")
      return { dueNow: params.cardId === "1", available: true };
    throw new Error(method);
  });
  const result = await pageStates(call, ["en:achieve"]);
  expect(result["en:achieve"].cards).toEqual([
    {
      cardId: "1",
      type: "review",
      queue: "review",
      intervalDays: 2,
      dueToday: true,
    },
    {
      cardId: "2",
      type: "review",
      queue: "review",
      intervalDays: 2,
      dueToday: false,
    },
    {
      cardId: "3",
      type: "review",
      queue: "review",
      intervalDays: 2,
      dueToday: false,
    },
  ]);
  expect(call.mock.calls.filter(([method]) => method === "scheduling.getDue")).toHaveLength(2);
  expect(
    call.mock.calls.filter(
      ([method, params]) => method === "cards.search" && params.query.includes("is:due"),
    ).map(([, params]) => params.cursor),
  ).toEqual([undefined, "due-next"]);
});
it("performs no work for an empty page", async () => {
  const call = vi.fn();
  expect(await pageStates(call, [])).toEqual({});
  expect(call).not.toHaveBeenCalled();
});
it("fails the snapshot on partial card errors", async () => {
  const call = vi.fn(async (method: string) => {
    if (method === "notes.search" || method === "cards.search")
      return { ids: ["1"] };
    if (method === "notes.getMany")
      return {
        items: [
          {
            result: {
              id: "1",
              fields: { Key: "en:achieve" },
              cardIds: ["1"],
              tags: [],
            },
          },
        ],
      };
    return { items: [{ error: { message: "gone" } }] };
  });
  await expect(pageStates(call, ["en:achieve"])).rejects.toThrow(
    "Cannot read card",
  );
});
