import { strict as assert } from "node:assert";
import { createServer } from "node:net";
import { checkConnection, rpc } from "../src/background/gateway.ts";
const settings = { port: 8766, apiKey: "" };
const status = await checkConnection(settings);
assert.equal(status, "ok");
console.log("127.0.0.1:8766:", status);
for (const method of ["decks.list", "noteTypes.list"]) {
  const result = await rpc(settings, method, {});
  console.log(method, JSON.stringify(result));
}
// Reserve an unused port, close it, then confirm refusal through the same gateway.
const server = createServer();
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address === "object");
await new Promise<void>((resolve, reject) =>
  server.close((error) => (error ? reject(error) : resolve())),
);
const unreachable = await checkConnection({ port: address.port, apiKey: "" });
assert.equal(unreachable, "unreachable");
console.log(`127.0.0.1:${address.port}:`, unreachable);
