import { DEFAULT_TARGET, type Call } from "./import";
import type { WordState } from "../reading";
const quote = (s: string) =>
  '"' + s.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
/** Bounded batches, pagination, exact Key readback, and no token-level requests. */
export async function pageStates(
  call: Call,
  keys: string[],
): Promise<Record<string, WordState>> {
  const states: Record<string, WordState> = {};
  const unique = [...new Set(keys)];
  for (let offset = 0; offset < unique.length; offset += 100) {
    const batch = unique.slice(offset, offset + 100);
    const keyFilter = `(${batch.map((k) => quote("Key:" + k)).join(" or ")})`;
    const query = `note:${quote(DEFAULT_TARGET.noteType)} ${keyFilter}`;
    const notes: any[] = [];
    let cursor: string | undefined;
    do {
      const result = await call("notes.search", {
        query,
        limit: 1000,
        ...(cursor ? { cursor } : {}),
      });
      if (result.ids.length) {
        const items = [];
        for (let i = 0; i < result.ids.length; i += 100)
          items.push(
            ...(
              await call("notes.getMany", { ids: result.ids.slice(i, i + 100) })
            ).items,
          );
        const data = { items };
        for (const item of data.items) {
          if (item.error) throw new Error("Cannot read note");
          if (batch.includes(item.result.fields.Key)) notes.push(item.result);
        }
      }
      cursor = result.nextCursor ?? undefined;
    } while (cursor);
    const cards: any[] = [];
    const dueTodayByCard = new Map<string, boolean>();
    cursor = undefined;
    if (notes.length) {
      do {
        const result = await call("cards.search", {
          query,
          limit: 1000,
          ...(cursor ? { cursor } : {}),
        });
        if (result.ids.length) {
          const items = [];
          for (let i = 0; i < result.ids.length; i += 100)
            items.push(
              ...(
                await call("cards.getMany", {
                  ids: result.ids.slice(i, i + 100),
                })
              ).items,
            );
          const data = { items };
          for (const item of data.items) {
            if (item.error) throw new Error("Cannot read card");
            cards.push(item.result);
          }
        }
        cursor = result.nextCursor ?? undefined;
      } while (cursor);
      const dueIds = new Set<string>();
      cursor = undefined;
      do {
        const result = await call("cards.search", {
          query: `note:${quote(DEFAULT_TARGET.noteType)} is:due ${keyFilter}`,
          limit: 1000,
          ...(cursor ? { cursor } : {}),
        });
        for (const id of result.ids) dueIds.add(String(id));
        cursor = result.nextCursor ?? undefined;
      } while (cursor);
      const candidates = [...dueIds];
      for (let start = 0; start < candidates.length; start += 20) {
        const due = await Promise.all(
          candidates.slice(start, start + 20).map(async (cardId) => {
            const result = await call("scheduling.getDue", { cardId });
            return [cardId, result.dueNow === true] as const;
          }),
        );
        for (const [cardId, isDue] of due) dueTodayByCard.set(cardId, isDue);
      }
    }
    for (const note of notes) {
      // Conflicting duplicate Keys must not silently select one note.
      if (notes.filter((n) => n.fields.Key === note.fields.Key).length !== 1)
        continue;
      states[note.fields.Key] = {
        fields: note.fields,
        level: note.tags
          .find((tag: string) => /^voka::level::(A1|A2|B1|B2|C1|C2)$/.test(tag))
          ?.split("::")[2],
        cards: cards
          .filter((c) => note.cardIds.includes(c.id))
          .map((c) => ({
            cardId: String(c.id),
            ...c.scheduling,
            dueToday: dueTodayByCard.get(String(c.id)) === true,
          })),
      };
    }
  }
  return states;
}
