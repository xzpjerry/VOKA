/** Browser acceptance: only isolated Anki 8766 and local mocks; never 8765. */
import puppeteer from "puppeteer";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
let mode = "old";
let allowed = false;
const calls: { mode: string; method: string }[] = [];
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString();
  const rpc = JSON.parse(body);
  calls.push({ mode, method: rpc.method });
  res.setHeader("Content-Type", "application/json");
  if (mode === "old")
    return res.end(JSON.stringify({ result: null, error: "legacy" }));
  if (mode === "version")
    return res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: rpc.id,
        result: { apiMajor: 1, ankiVersion: "25.09", methods: [] },
      }),
    );
  if (mode === "auth" && req.headers.authorization !== "Bearer acceptance-key") {
    res.statusCode = 401;
    return res.end("{}");
  }
  if (mode === "forbidden" && !allowed) {
    if (rpc.method === "access.requestPermission") {
      allowed = true;
      return res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          result: { permission: "granted" },
        }),
      );
    }
    res.statusCode = 403;
    return res.end("{}");
  }
  const response = await fetch("http://127.0.0.1:8766/api/v1", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  res.statusCode = response.status;
  res.end(await response.text());
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const mockPort = (server.address() as { port: number }).port;
let browser;
const evidence: Record<string, unknown> = {};
// Seed the isolated port from the service worker before onInstalled opens the
// wizard. The write is queued during worker startup, well before the new page
// loads and reads settings, so it never sends a request to the default 8765.
const scratch = await mkdtemp(join(tmpdir(), "voka-onboarding-"));
const extension = join(scratch, "extension");
await cp(resolve("dist"), extension, { recursive: true });
const backgroundFile = join(extension, "background.js");
const seed =
  'chrome.storage.local.get("port").then((seeded) => {' +
  'if (typeof seeded.port !== "number") return chrome.storage.local.set({ port: 8766, apiKey: "" }); });';
await writeFile(
  backgroundFile,
  seed + (await readFile(backgroundFile, "utf8")),
);
const netlog = join(scratch, "netlog.json");
try {
  browser = await puppeteer.launch({
    headless: false,
    enableExtensions: [extension],
    args: [
      "--no-first-run",
      `--log-net-log=${netlog}`,
      "--net-log-capture-mode=IncludeSensitive",
    ],
  });
  const worker = (await (
    await browser.waitForTarget((t) => t.type() === "service_worker")
  ).worker())!;
  const id = worker.url().split("/")[2];
  const wizardTarget = await browser.waitForTarget(
    (t) => t.url() === `chrome-extension://${id}/options.html?wizard=1`,
  );
  const wizard = (await wizardTarget.page())!;
  // No clicks: the first check runs as part of opening step ①.
  await wizard.waitForFunction(
    () => document.querySelector("#status")?.textContent === "已连接",
  );
  assert.equal(
    await wizard.$eval("#port", (e: HTMLInputElement) => e.value),
    "8766",
  );
  assert.equal(
    await wizard.$eval("#nextConnection", (e: HTMLButtonElement) => e.disabled),
    false,
  );
  const autoChecks = await wizard.$$eval("#checks li", (els) =>
    els.map((e) => e.textContent),
  );
  assert.equal(autoChecks.length, 4);
  assert(autoChecks.every((text) => text?.includes("通过")));
  assert.equal(
    await wizard.$eval("#retry", (e: HTMLButtonElement) => e.disabled),
    false,
  );
  evidence.install =
    "onInstalled opened full-page wizard; saved port 8766 auto-checked on open with no click";
  // Reload with an unreachable saved port: the open-time check must report it
  // without a click, and changing storage while open must not retrigger it.
  const closed = createServer();
  await new Promise<void>((done) => closed.listen(0, "127.0.0.1", done));
  const closedPort = (closed.address() as { port: number }).port;
  await new Promise<void>((done) => closed.close(() => done()));
  await worker.evaluate(
    (port) => chrome.storage.local.set({ port }),
    closedPort,
  );
  await wizard.reload();
  await wizard.waitForFunction(
    () => document.querySelector("#status")?.textContent === "VOKA 未运行：请检查 Anki",
  );
  assert.match(
    await wizard.$eval("#checks", (e) => e.textContent!),
    /2055492159/,
  );
  assert.equal(
    await wizard.$eval("#nextConnection", (e: HTMLButtonElement) => e.disabled),
    true,
  );
  evidence.autoCheckClosedPort = {
    port: closedPort,
    result: "unreachable on open, no click required",
  };
  await worker.evaluate(() => chrome.storage.local.set({ port: 8766 }));
  await wizard.reload();
  await wizard.waitForFunction(
    () => document.querySelector("#status")?.textContent === "已连接",
  );
  await wizard.click("#nextConnection");
  await wizard.select("#nativeLanguage", "en");
  assert(await wizard.$eval("#glossLanguageRow", (e: HTMLElement) => e.hidden));
  const counts = await wizard.$$eval("#levels label", (els) =>
    els.map((e) => e.textContent),
  );
  assert.deepEqual(counts, [
    "A1 · 1,050 词",
    "A2 · 1,200 词",
    "B1 · 2,085 词",
    "B2 · 2,383 词",
    "C1 · 909 词",
    "C2 · 868 词",
  ]);
  await wizard.click('input[value="A2"]');
  await wizard.click("#nextLearning");
  await wizard.waitForFunction(() =>
    document
      .querySelector("#importStatus")
      ?.textContent?.includes("VOKA::English::A2"),
  );
  assert.match(
    await wizard.$eval("#importStatus", (e) => e.textContent!),
    /新建|已存在/,
  );
  await mkdir("docs/research/onboarding-evidence", { recursive: true });
  await wizard.screenshot({
    path: "docs/research/onboarding-evidence/wizard.png",
    fullPage: true,
  });
  await wizard.click("#skip");
  await wizard.waitForFunction(
    () => document.querySelector("#status")?.textContent === "已连接",
  );
  await wizard.waitForFunction(() =>
    document.body.textContent?.includes("Princeton"),
  );
  assert.equal(
    await wizard.$eval('input[value="A2"]', (e: HTMLInputElement) => e.checked),
    true,
  );
  await wizard.select("#nativeLanguage", "zh");
  await wizard.select("#glossLanguage", "target");
  await wizard.waitForFunction(
    async () =>
      (await chrome.storage.local.get("glossLanguage")).glossLanguage ===
      "target",
  );
  await wizard.reload();
  await wizard.waitForFunction(
    () => document.querySelector("#status")?.textContent === "已连接",
  );
  assert.equal(
    await wizard.$eval("#glossLanguage", (e: HTMLSelectElement) => e.value),
    "target",
  );
  await wizard.screenshot({
    path: "docs/research/onboarding-evidence/settings.png",
    fullPage: true,
  });
  evidence.real = {
    anki: "26.09.3 at 8766",
    counts,
    preview: "A2 read-only",
    persistence: "nativeLanguage, glossLanguage, targetLevel",
    attribution: "Princeton and complete source details retained",
  };
  async function checkPort(port: number, expected: RegExp) {
    await wizard.$eval(
      "#port",
      (e: HTMLInputElement, value) => {
        e.value = String(value);
        e.dispatchEvent(new Event("input", { bubbles: true }));
      },
      port,
    );
    await wizard.click("#retry");
    await wizard.waitForFunction(
      () => !(document.querySelector("#retry") as HTMLButtonElement).disabled,
    );
    assert.match(
      await wizard.$eval("#checks", (e) => e.textContent!),
      expected,
    );
    assert.equal(
      await wizard.$eval("#learning", (e: HTMLFieldSetElement) => e.disabled),
      true,
    );
  }
  for (const [state, expected] of [
    ["old", /升级到 Anki/],
    ["version", /升级到 Anki/],
    ["auth", /正确的 API Key/],
    ["forbidden", /webCorsOriginList/],
  ] as const) {
    mode = state;
    await checkPort(mockPort, expected);
    const before = calls.length;
    await new Promise((done) => setTimeout(done, 400));
    assert.equal(calls.length, before);
    await wizard.screenshot({
      path: `docs/research/onboarding-evidence/${state}.png`,
      fullPage: true,
    });
    if (state === "auth") {
      await wizard.type("#apiKey", "acceptance-key");
      await wizard.click("#retry");
      await wizard.waitForFunction(() => document.querySelector("#status")?.textContent === "已连接");
      const saved = await worker.evaluate(() => chrome.storage.local.get(["port", "apiKey"]));
      assert.equal(saved.port, mockPort); assert.equal(saved.apiKey, "acceptance-key");
      await wizard.$eval("#apiKey", (el: HTMLInputElement) => { el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true })); });
    }
  }
  await wizard.click("#access");
  await wizard.waitForFunction(() =>
    document
      .querySelector("#accessStatus")
      ?.textContent?.includes("请求已返回"),
  );
  assert(calls.some((c) => c.method === "access.requestPermission"));
  assert.equal(
    await wizard.$eval("#learning", (e: HTMLFieldSetElement) => e.disabled),
    true,
  );
  await wizard.click("#retry");
  await wizard.waitForFunction(
    () => document.querySelector("#status")?.textContent === "已连接",
  );
  assert(!calls.some((c) => /create|update|delete/.test(c.method)));
  evidence.mock =
    "legacy endpoint, old Anki, HTTP 401, HTTP 403 → access.requestPermission → explicit recheck → real 8766 success; no polling; no import writes";
  evidence.browser = await browser.version();
  await browser.close();
  browser = undefined;
  const log = await readFile(netlog, "utf8");
  const hits = (port: number) =>
    (log.match(new RegExp(`(?<!\\d)127\\.0\\.0\\.1:${port}(?!\\d)`, "g")) ?? [])
      .length;
  const request8766 = hits(8766);
  const request8765 = hits(8765);
  assert.equal(request8765, 0, "browser acceptance must never request 8765");
  assert(request8766 > 0, "expected real 8766 connection checks");
  evidence.requestLog = {
    "127.0.0.1:8765": request8765,
    "127.0.0.1:8766": request8766,
    source: "Chrome netlog captured for the whole acceptance run",
  };
  await writeFile(
    "docs/research/onboarding-evidence/results.json",
    JSON.stringify(evidence, null, 2),
  );
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await browser?.close();
  server.close();
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
}
