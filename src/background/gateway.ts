export type Settings = { port: number; apiKey: string };
export type Status =
  "ok" | "unreachable" | "not-new-ankiconnect" | "forbidden" | "auth";
export const REQUIRED_METHODS = [
  "api.describe",
  "access.requestPermission",
  "decks.list",
  "decks.create",
  "noteTypes.list",
  "noteTypes.get",
  "noteTypes.create",
  "noteTypes.update",
  "notes.validateMany",
  "notes.createMany",
  "notes.search",
  "notes.getMany",
  "cards.search",
  "cards.getMany",
  "notes.update",
  "tags.add",
  "tags.remove",
  "operations.get",
  "collection.sync",
];
const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
export class GatewayError extends Error {
  constructor(
    public status: Exclude<Status, "ok">,
    public outcome: "failed" | "unknown" = "failed",
  ) {
    super(status);
  }
}
/** Exactly one attempt. A failed transport for a mutation has an unknown outcome. */
export async function rpc(
  settings: Settings,
  method: string,
  params: Record<string, unknown> = {},
  options: {
    fetch?: typeof fetch;
    timeoutMs?: number;
    sideEffecting?: boolean;
  } = {},
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5000);
  const id = crypto.randomUUID();
  try {
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(
        `http://127.0.0.1:${settings.port}/api/v1`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(settings.apiKey
              ? { Authorization: `Bearer ${settings.apiKey}` }
              : {}),
          },
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
          signal: controller.signal,
        },
      );
    } catch {
      throw new GatewayError(
        "unreachable",
        options.sideEffecting ? "unknown" : "failed",
      );
    }
    if (response.status === 403) throw new GatewayError("forbidden");
    if (response.status === 401) throw new GatewayError("auth");
    if (!response.ok)
      throw new GatewayError(
        "unreachable",
        options.sideEffecting ? "unknown" : "failed",
      );
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new GatewayError(
        controller.signal.aborted ? "unreachable" : "not-new-ankiconnect",
        options.sideEffecting ? "unknown" : "failed",
      );
    }
    if (
      !object(data) ||
      data.jsonrpc !== "2.0" ||
      data.id !== id ||
      "result" in data === "error" in data
    )
      throw new GatewayError(
        "not-new-ankiconnect",
        options.sideEffecting ? "unknown" : "failed",
      );
    if ("error" in data) {
      const error = data.error;
      if (
        !object(error) ||
        !Number.isInteger(error.code) ||
        typeof error.message !== "string"
      )
        throw new GatewayError("not-new-ankiconnect");
      throw new GatewayError(
        error.code === 1011 ||
          (object(error.data) && error.data.type === "authenticationRequired")
          ? "auth"
          : "not-new-ankiconnect",
      );
    }
    return data.result;
  } finally {
    clearTimeout(timer);
  }
}
export async function checkConnection(
  settings: Settings,
  options: Parameters<typeof rpc>[3] = {},
): Promise<Status> {
  try {
    const data = await rpc(settings, "api.describe", {}, options);
    if (
      !object(data) ||
      data.apiMajor !== 1 ||
      typeof data.ankiVersion !== "string" ||
      !/^\d+\.\d+(?:\.\d+)?$/.test(data.ankiVersion)
    )
      return "not-new-ankiconnect";
    const [major, minor] = data.ankiVersion.split(".").map(Number);
    if (
      major < 26 ||
      (major === 26 && minor < 8) ||
      !Array.isArray(data.methods)
    )
      return "not-new-ankiconnect";
    const available = new Set(
      data.methods
        .filter((m) => object(m) && m.available === true)
        .map((m) => m.name),
    );
    return REQUIRED_METHODS.every((m) => available.has(m))
      ? "ok"
      : "not-new-ankiconnect";
  } catch (error) {
    return error instanceof GatewayError ? error.status : "unreachable";
  }
}
