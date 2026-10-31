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
  for (let offset = 0; offset < unique.length; offset += 200) {
    const batch = unique.slice(offset, offset + 200);
    const query = `note:${quote(DEFAULT_TARGET.noteType)} (${batch.map((k) => quote("Key:" + k)).join(" or ")})`;
    const notes: any[] = [];
    let cursor: string | undefined;
    do {
      const result = await call("notes.search", {
        query,
        limit: 1000,
        ...(cursor ? { cursor } : {}),
      });
      if (result.ids.length) {
        const data = await call("notes.getMany", { ids: result.ids });
        for (const item of data.items) {
          if (item.error) throw new Error("Cannot read note");
          if (batch.includes(item.result.fields.Key)) notes.push(item.result);
        }
      }
      cursor = result.nextCursor ?? undefined;
    } while (cursor);
    const cards: any[] = [];
    cursor = undefined;
    if (notes.length)
      do {
        const result = await call("cards.search", {
          query,
          limit: 1000,
          ...(cursor ? { cursor } : {}),
        });
        if (result.ids.length) {
          const data = await call("cards.getMany", { ids: result.ids });
          for (const item of data.items) {
            if (item.error) throw new Error("Cannot read card");
            cards.push(item.result);
          }
        }
        cursor = result.nextCursor ?? undefined;
      } while (cursor);
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
          .map((c) => c.scheduling),
      };
    }
  }
  return states;
}
