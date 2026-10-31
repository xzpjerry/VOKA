import { describe, it, expect, vi } from "vitest";
import { checkConnection, rpc, REQUIRED_METHODS } from "./gateway";
const settings = { port: 8766, apiKey: "" };
const description = {
  apiMajor: 1,
  ankiVersion: "26.09.3",
  methods: REQUIRED_METHODS.map((name) => ({ name, available: true })),
};
function reply(result: unknown = description) {
  return vi.fn(
    async (_url, init) =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: JSON.parse(init!.body as string).id,
          result,
        }),
      ),
  );
}
describe("v1 gateway", () => {
  it("sends the JSON-RPC envelope, configured port and Bearer header", async () => {
    const fetch = reply();
    expect(
      await checkConnection({ ...settings, apiKey: "secret" }, { fetch }),
    ).toBe("ok");
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:8766/api/v1");
    expect(init!.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer secret",
    });
    expect(JSON.parse(init!.body as string)).toEqual({
      jsonrpc: "2.0",
      id: expect.any(String),
      method: "api.describe",
      params: {},
    });
  });
  it.each([401, 403, 500])("classifies HTTP %s", async (code) => {
    expect(
      await checkConnection(settings, {
        fetch: vi.fn(async () => new Response("", { status: code })),
      }),
    ).toBe(code === 401 ? "auth" : code === 403 ? "forbidden" : "unreachable");
  });
  it("classifies connection refusal", async () => {
    expect(
      await checkConnection(settings, {
        fetch: vi.fn().mockRejectedValue(new TypeError("network")),
      }),
    ).toBe("unreachable");
  });
  it.each([
    {},
    { apiMajor: 6 },
    { ...description, ankiVersion: "26.07" },
    { ...description, methods: [] },
    {
      ...description,
      methods: description.methods.map((m) => ({ ...m, available: false })),
    },
  ])("rejects incompatible descriptions", async (value) => {
    expect(await checkConnection(settings, { fetch: reply(value) })).toBe(
      "not-new-ankiconnect",
    );
  });
  it.each([
    { result: description, error: { code: 1, message: "error" } },
    { result: description, id: "wrong" },
    { result: description, jsonrpc: "1.0" },
    { error: null },
  ])("rejects malformed envelopes", async (fields) => {
    const fetch = vi.fn(
      async (_url, init) =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: JSON.parse(init!.body as string).id,
            ...fields,
          }),
        ),
    );
    expect(await checkConnection(settings, { fetch })).toBe(
      "not-new-ankiconnect",
    );
  });
  it("classifies RPC authentication errors", async () => {
    const fetch = vi.fn(
      async (_url, init) =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: JSON.parse(init!.body as string).id,
            error: {
              code: 1011,
              message: "Authentication required",
              data: { type: "authenticationRequired" },
            },
          }),
        ),
    );
    expect(await checkConnection(settings, { fetch })).toBe("auth");
  });
  it("rejects non-JSON", async () => {
    expect(
      await checkConnection(settings, {
        fetch: vi.fn(async () => new Response("html")),
      }),
    ).toBe("not-new-ankiconnect");
  });
  it("does not retry a timed-out mutation and reports unknown", async () => {
    const fetch = vi.fn(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) =>
          init!.signal!.addEventListener("abort", () =>
            reject(new Error("timeout")),
          ),
        ),
    );
    await expect(
      rpc(
        settings,
        "notes.createMany",
        {},
        { fetch, timeoutMs: 5, sideEffecting: true },
      ),
    ).rejects.toMatchObject({ status: "unreachable", outcome: "unknown" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
