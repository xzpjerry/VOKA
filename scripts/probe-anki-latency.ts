const PORT = 8766;
const ENDPOINT = `http://127.0.0.1:${PORT}/api/v1`;
const DEFAULT_SECONDS = 300;

function argument(name: string, fallback: number) {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`));
  const index = process.argv.indexOf(name);
  const raw = inline?.slice(name.length + 1) ??
    (index >= 0 ? process.argv[index + 1] : undefined);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 3600)
    throw new Error(`${name} must be an integer between 1 and 3600`);
  return value;
}

const seconds = argument("--seconds", DEFAULT_SECONDS);
let nextId = 0;
const active = new Set<Promise<void>>();
let requestInFlight = false;

async function probe() {
  const id = ++nextId;
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `latency-probe-${id}`,
        method: "api.describe",
        params: {},
      }),
      signal: controller.signal,
    });
    await response.arrayBuffer();
    console.log(
      JSON.stringify({
        type: "anki-probe",
        port: PORT,
        id,
        startedAt: new Date(startedAt).toISOString(),
        durationMs: Date.now() - startedAt,
        status: response.status,
        outcome: response.ok ? "ok" : "http-error",
      }),
    );
  } catch (error) {
    console.log(
      JSON.stringify({
        type: "anki-probe",
        port: PORT,
        id,
        startedAt: new Date(startedAt).toISOString(),
        durationMs: Date.now() - startedAt,
        outcome: controller.signal.aborted ? "timeout" : "unreachable",
        error: error instanceof Error ? error.name : "error",
      }),
    );
  } finally {
    clearTimeout(timeout);
    requestInFlight = false;
  }
}

function startProbe() {
  if (requestInFlight) return;
  requestInFlight = true;
  const request = probe().finally(() => active.delete(request));
  active.add(request);
}

console.log(
  JSON.stringify({
    type: "anki-probe-start",
    port: PORT,
    endpoint: ENDPOINT,
    intervalMs: 500,
    seconds,
  }),
);
startProbe();
const interval = setInterval(startProbe, 500);
await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
clearInterval(interval);
await Promise.allSettled([...active]);
console.log(JSON.stringify({ type: "anki-probe-stop", port: PORT, probes: nextId }));
