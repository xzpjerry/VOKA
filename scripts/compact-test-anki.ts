import { rpc } from "../src/background/gateway";

const PORT = 8766;
const PREFIXES = ["VOKA Test::", "VOKA Research", "VOKA::Gloss "];
const config = { port: PORT, apiKey: "" };
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const call = (method: string, params: Record<string, unknown> = {}, write = false) =>
  rpc(config, method, params, { sideEffecting: write });
function assertItemsSucceeded(method: string, result: any) {
  if (!Array.isArray(result?.items))
    throw new Error(`${method} returned no item results`);
  for (const item of result.items)
    if (item.error || !item.result)
      throw new Error(`${method} item failed: ${JSON.stringify(item)}`);
}

function requestedPort() {
  const inline = process.argv.find((value) => value.startsWith("--port="));
  const index = process.argv.indexOf("--port");
  const raw = inline?.slice("--port=".length) ??
    (index >= 0 ? process.argv[index + 1] : undefined);
  return raw === undefined ? PORT : Number(raw);
}

function searchQuote(value: string) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

async function noteIdsForDeck(deck: string) {
  const ids = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = (await call("notes.search", {
      query: `deck:${searchQuote(deck)}`,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    })) as { ids?: unknown[]; nextCursor?: string | null };
    for (const id of page.ids ?? []) ids.add(String(id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return [...ids];
}

async function deleteLeftovers() {
  const decks = (await call("decks.list")) as { name: string }[];
  const names = decks
    .map((deck) => deck.name)
    .filter((name) => PREFIXES.some((prefix) => name.startsWith(prefix)));
  console.log(JSON.stringify({ type: "cleanup-targets", port: PORT, decks: names }));

  const noteIds = new Set<string>();
  for (const name of names)
    for (const id of await noteIdsForDeck(name)) noteIds.add(id);

  const ids = [...noteIds];
  for (let start = 0; start < ids.length; start += 100)
    assertItemsSucceeded(
      "notes.delete",
      await call("notes.delete", { ids: ids.slice(start, start + 100) }, true),
    );

  let currentDecks = (await call("decks.list")) as { name: string }[];
  const existing = new Set(currentDecks.map((deck) => deck.name));
  const deepestFirst = [...names].sort(
    (left, right) => right.split("::").length - left.split("::").length,
  );
  for (const name of deepestFirst) {
    if (!existing.has(name)) continue;
    assertItemsSucceeded(
      "decks.delete",
      await call(
        "decks.delete",
        { decks: [{ name }], deleteCards: true },
        true,
      ),
    );
    currentDecks = (await call("decks.list")) as { name: string }[];
    existing.clear();
    for (const deck of currentDecks) existing.add(deck.name);
  }
  return { decksRemoved: names.length, notesRemoved: ids.length };
}

async function runIntegrityCheck(methods: unknown[]) {
  const available = methods.some(
    (method) =>
      typeof method === "object" &&
      method !== null &&
      "name" in method &&
      method.name === "collection.checkIntegrity" &&
      "available" in method &&
      method.available === true,
  );
  if (!available) {
    console.log(JSON.stringify({ type: "integrity-check", outcome: "unavailable" }));
    return "unavailable";
  }

  const started = (await call("collection.checkIntegrity", {}, true)) as {
    operationId?: string;
  };
  if (!started.operationId)
    throw new Error("collection.checkIntegrity returned no operationId");

  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    const operation = (await call("operations.get", {
      operationId: started.operationId,
    })) as { state?: string; result?: unknown; error?: unknown };
    if (operation.state === "succeeded") {
      console.log(
        JSON.stringify({
          type: "integrity-check",
          outcome: "succeeded",
          result: operation.result,
        }),
      );
      return "succeeded";
    }
    if (operation.state === "failed" || operation.state === "cancelled")
      throw new Error(
        `collection.checkIntegrity ${operation.state}: ${JSON.stringify(operation.error)}`,
      );
    await delay(1000);
  }
  throw new Error("collection.checkIntegrity did not finish within 10 minutes");
}

async function main() {
  const port = requestedPort();
  if (port !== PORT)
    throw new Error(`Refusing port ${port}; this command only uses 127.0.0.1:${PORT}`);

  const description = (await call("api.describe")) as {
    methods?: unknown[];
    apiMajor?: number;
  };
  if (description.apiMajor !== 1 || !Array.isArray(description.methods))
    throw new Error("Port 8766 did not return an AnkiConnect v1 description");

  const cleanup = await deleteLeftovers();
  const integrity = await runIntegrityCheck(description.methods);
  console.log(
    JSON.stringify({
      type: "test-anki-compacted",
      port: PORT,
      ...cleanup,
      integrity,
    }),
  );
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
