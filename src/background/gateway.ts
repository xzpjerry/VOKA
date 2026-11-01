declare const __VOKA_RPC_LOG__: boolean;

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
  "cards.render",
  "scheduling.getDue",
  "scheduling.get",
  "scheduling.predict",
  "scheduling.answer",
  "reviews.getLatestId",
  "reviews.list",
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
    public code?: number,
  ) {
    super(status);
  }
}

const RPC_LOG_ENABLED =
  typeof __VOKA_RPC_LOG__ !== "undefined" && __VOKA_RPC_LOG__;

class RpcTimeoutError extends GatewayError {
  constructor(sideEffecting: boolean) {
    super("unreachable", sideEffecting ? "unknown" : "failed");
    this.name = "RpcTimeoutError";
  }
}

function logAttempt(method: string, startedAt: number, outcome: string) {
  if (!RPC_LOG_ENABLED) return;
  console.info(
    `[VOKA_RPC] ${JSON.stringify({
      method,
      startedAt: new Date(startedAt).toISOString(),
      durationMs: Date.now() - startedAt,
      outcome,
    })}`,
  );
}

async function rpcAttempt(
  settings: Settings,
  method: string,
  params: Record<string, unknown>,
  options: RpcOptions,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
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
      if (controller.signal.aborted)
        throw new RpcTimeoutError(!!options.sideEffecting);
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
      if (controller.signal.aborted)
        throw new RpcTimeoutError(!!options.sideEffecting);
      throw new GatewayError(
        "not-new-ankiconnect",
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
        "failed",
        error.code as number,
      );
    }
    logAttempt(method, startedAt, "ok");
    return data.result;
  } catch (error) {
    logAttempt(
      method,
      startedAt,
      error instanceof RpcTimeoutError
        ? options.sideEffecting
          ? "timeout-unknown"
          : "timeout"
        : error instanceof GatewayError
          ? error.status
          : "error",
    );
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

type RpcOptions = {
  fetch?: typeof fetch;
  timeoutMs?: number;
  sideEffecting?: boolean;
};

/** Read-only calls retry one timeout; mutation timeouts remain outcome-unknown. */
export async function rpc(
  settings: Settings,
  method: string,
  params: Record<string, unknown> = {},
  options: RpcOptions = {},
): Promise<unknown> {
  const sideEffecting = !!options.sideEffecting;
  try {
    return await rpcAttempt(
      settings,
      method,
      params,
      options,
      options.timeoutMs ?? (sideEffecting ? 15000 : 5000),
    );
  } catch (error) {
    if (sideEffecting || !(error instanceof RpcTimeoutError)) throw error;
    return rpcAttempt(settings, method, params, options, 15000);
  }
}

export function createConnectionFailureTracker() {
  let connected = false;
  let consecutiveFailures = 0;

  return {
    observe(status: Status): { status: Status; disconnect: boolean } {
      if (status === "ok") {
        connected = true;
        consecutiveFailures = 0;
        return { status, disconnect: false };
      }
      if (status === "unreachable") {
        consecutiveFailures += 1;
        if (connected && consecutiveFailures < 2)
          return { status: "ok", disconnect: false };
        return { status, disconnect: true };
      }
      consecutiveFailures = 0;
      return { status, disconnect: true };
    },
  };
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
