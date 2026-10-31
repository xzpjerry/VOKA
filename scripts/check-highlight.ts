import puppeteer from "puppeteer";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { rpc } from "../src/background/gateway";
import {
  lookup,
  DEFAULT_TARGET,
  executeImport,
} from "../src/background/import";
import { pageStates } from "../src/background/reading";
const call = (method: string, params = {}, write = false) =>
  rpc({ port: 8766, apiKey: "" }, method, params, {
    sideEffecting: write,
  }) as Promise<any>;
await executeImport(call);
const keys = ["en:advice", "en:afford"];
const found = await lookup(call, DEFAULT_TARGET, keys);
const original = (
  await call("notes.getMany", { ids: keys.map((k) => found.get(k)![0]) })
).items.map((i: any) => i.result);
const server = createServer(async (_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.end(await readFile(new URL("./highlight-fixture.html", import.meta.url)));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
let browser;
try {
  for (const [index, note] of original.entries())
    await call(
      "notes.update",
      {
        id: note.id,
        patch: { fields: { ManualStatus: index === 0 ? "known" : "unknown" } },
      },
      true,
    );
  const states = await pageStates(call, ["en:achieve", ...keys, "en:improve"]);
  assert.equal(states["en:advice"].fields.ManualStatus, "known");
  assert.equal(states["en:afford"].fields.ManualStatus, "unknown");
  browser = await puppeteer.launch({
    headless: false,
    enableExtensions: [resolve("dist")],
    args: ["--no-first-run"],
  });
  const workerTarget = await browser.waitForTarget(
    (t) => t.type() === "service_worker",
  );
  const worker = (await workerTarget.worker())!;
  await worker.evaluate(() =>
    chrome.storage.local.set({
      port: 8766,
      apiKey: "",
      hoverScope: "highlighted",
      targetLevel: "B1",
      showAdvanced: false,
    }),
  );
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 950 });
  await page.goto(`http://127.0.0.1:${port}`);
  const tabId = await worker.evaluate(
    async () =>
      (await chrome.tabs.query({})).find((t) => t.url?.includes("127.0.0.1:"))!
        .id!,
  );
  const inject = () =>
    worker.evaluate(
      async (id) =>
        chrome.scripting.executeScript({
          target: { tabId: id },
          files: ["content.js"],
        }),
      tabId,
    );
  const before = await page.$eval("#words", (el) => ({
    text: el.textContent,
    html: el.innerHTML,
    rect: JSON.stringify(el.getBoundingClientRect()),
  }));
  await inject();
  const snapshot = () =>
    page.evaluate(() =>
      Object.fromEntries(
        [...CSS.highlights].map(([key, value]) => [
          key,
          [...value].map((r) => ({
            text: r.toString(),
            parent: r.startContainer.parentElement?.id,
            tag: r.startContainer.parentElement?.tagName,
          })),
        ]),
      ),
    );
  await page.waitForFunction(() => CSS.highlights.get("voka-target")?.size);
  const first = await snapshot();
  assert.deepEqual(
    await page.$eval("#words", (el) => ({
      text: el.textContent,
      html: el.innerHTML,
      rect: JSON.stringify(el.getBoundingClientRect()),
    })),
    before,
  );
  assert(first["voka-target"].some((r) => r.text === "achieved"));
  assert(first["voka-target"].some((r) => r.text === "improve"));
  assert(
    !Object.values(first)
      .flat()
      .some(
        (r) =>
          r.text === "advice" || r.text === "apple" || r.text === "abandoning",
      ),
  );
  assert(first["voka-unknown"].some((r) => r.text === "afford"));
  assert(
    !Object.values(first)
      .flat()
      .some((r) =>
        [
          "INPUT",
          "TEXTAREA",
          "PRE",
          "CODE",
          "NAV",
          "FOOTER",
          "KBD",
          "SAMP",
        ].includes(r.tag ?? ""),
      ),
  );
  assert.equal(
    Object.values(first)
      .flat()
      .filter((r) => r.text === "achieved" || r.text === "achieve").length,
    1,
  );
  const hover = async (id: string) => {
    const box = await (await page.$("#" + id))!.boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  };
  const tip = () =>
    page.evaluate(() => {
      const el = document
        .getElementById("voka-drawer")!
        .shadowRoot!.querySelector("[role=tooltip]") as HTMLElement;
      return { hidden: el.hidden, text: el.textContent };
    });
  await hover("achieve");
  assert.equal((await tip()).hidden, false);
  assert.match((await tip()).text!, /achieve/);
  await mkdir("docs/research/highlight-evidence", { recursive: true });
  await page.screenshot({
    path: "docs/research/highlight-evidence/connected.png",
  });
  await hover("advice");
  assert.equal((await tip()).hidden, true);
  await hover("apple");
  assert.equal((await tip()).hidden, true);
  await worker.evaluate(() =>
    chrome.storage.local.set({
      hoverScope: "all",
      showAdvanced: true,
    }),
  );
  await page.waitForFunction(() => CSS.highlights.get("voka-weak")?.size === 1);
  await hover("apple");
  assert.equal((await tip()).hidden, false);
  await worker.evaluate(() =>
    chrome.storage.local.set({ targetLevel: "B2", showAdvanced: false }),
  );
  await page.waitForFunction(() =>
    [...(CSS.highlights.get("voka-target") ?? [])].some(
      (r) => r.toString() === "abandoning",
    ),
  );
  await worker.evaluate(() =>
    chrome.storage.local.set({ targetLevel: "B1", showAdvanced: true }),
  );
  await page.waitForFunction(() => CSS.highlights.get("voka-weak")?.size === 1);
  await page.evaluate(() => {
    document.getElementById("dynamic")!.textContent = "develop achieved";
  });
  await page.waitForFunction(() =>
    [...(CSS.highlights.get("voka-target") ?? [])].some(
      (r) => r.toString() === "develop",
    ),
  );
  await page.evaluate(() => {
    document.getElementById("dynamic")!.setAttribute("contenteditable", "true");
  });
  await page.waitForFunction(
    () =>
      ![...(CSS.highlights.get("voka-target") ?? [])].some(
        (r) => r.startContainer.parentElement?.id === "dynamic",
      ),
  );
  // Closed ephemeral port; no requests to 8765, and no need to stop anyone else's Anki.
  const closed = createServer();
  await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
  const closedPort = (closed.address() as { port: number }).port;
  await new Promise<void>((r) => closed.close(() => r()));
  await hover("achieve");
  await worker.evaluate(
    (port) => chrome.storage.local.set({ port }),
    closedPort,
  );
  await page.waitForFunction(
    () =>
      CSS.highlights.size === 0 &&
      (
        document
          .getElementById("voka-drawer")!
          .shadowRoot!.querySelector("[role=tooltip]") as HTMLElement
      ).hidden,
  );
  await page.waitForFunction(() =>
    /未运行|not running/i.test(
      document
        .getElementById("voka-drawer")!
        .shadowRoot!.querySelector("[role=status]")!.textContent!,
    ),
  );
  const summary = await page.evaluate(
    () =>
      document
        .getElementById("voka-drawer")!
        .shadowRoot!.querySelector("[role=status]")!.textContent,
  );
  assert.match(summary!, /未运行|not running/i);
  await page.screenshot({
    path: "docs/research/highlight-evidence/disconnected.png",
  });
  await worker.evaluate(() => chrome.storage.local.set({ port: 8766 }));
  await page.waitForFunction(() => CSS.highlights.get("voka-target")?.size);
  await inject(); // repeated toolbar injection refreshes, rather than creating another host
  assert.equal(await page.$$eval("#voka-drawer", (els) => els.length), 1);
  console.log(
    JSON.stringify(
      {
        browser: await browser.version(),
        initialHighlights: first,
        summary,
        checks:
          "exclusions; unchanged text/HTML/layout; imported B1 + not-in-Anki B2 target; manual known/unknown; hover scope; advanced inflection; dynamic text + exclusion; disconnect clears all; reconnect; single host",
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  server.close();
  for (const note of original)
    await call(
      "notes.update",
      {
        id: note.id,
        patch: { fields: { ManualStatus: note.fields.ManualStatus } },
      },
      true,
    );
}
