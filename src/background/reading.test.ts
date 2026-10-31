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
    if (method === "cards.search") return { ids: ["1"] };
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
    throw new Error(method);
  });
  const result = await pageStates(call, [
    "en:achieve",
    "en:achieve",
    "en:advice",
  ]);
  expect(result["en:achieve"].cards[0].intervalDays).toBe(21);
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
      ].includes(c[0]),
    ),
  ).toBe(true);
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
