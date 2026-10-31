/** Browser acceptance: only isolated Anki 8766 and local mocks; never 8765. */
import puppeteer from "puppeteer";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
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
try {
  browser = await puppeteer.launch({
    headless: false,
    enableExtensions: [resolve("dist")],
    args: ["--no-first-run"],
  });
  const worker = (await (
    await browser.waitForTarget((t) => t.type() === "service_worker")
  ).worker())!;
  const id = worker.url().split("/")[2];
  const wizardTarget = await browser.waitForTarget(
    (t) => t.url() === `chrome-extension://${id}/options.html?wizard=1`,
  );
  const wizard = (await wizardTarget.page())!;
  await wizard.waitForSelector("#checks li");
  evidence.install =
    "onInstalled opened full-page wizard; waits for first port confirmation";
  assert.equal(
    await wizard.$eval("#nextConnection", (e: HTMLButtonElement) => e.disabled),
    true,
  );
  await worker.evaluate(() =>
    chrome.storage.local.set({ port: 8766, apiKey: "" }),
  );
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
  // Reserve then close a port to ensure an unreachable endpoint.
  const closed = createServer();
  await new Promise<void>((done) => closed.listen(0, "127.0.0.1", done));
  const closedPort = (closed.address() as { port: number }).port;
  await new Promise<void>((done) => closed.close(() => done()));
  await checkPort(closedPort, /2055492159/);
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
    "closed port, legacy endpoint, old Anki, HTTP 401, HTTP 403 → access.requestPermission → explicit recheck → real 8766 success; no polling; no import writes";
  evidence.browser = await browser.version();
  await writeFile(
    "docs/research/onboarding-evidence/results.json",
    JSON.stringify(evidence, null, 2),
  );
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await browser?.close();
  server.close();
}
