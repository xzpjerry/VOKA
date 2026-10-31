import { testPack } from "../src/data/test-pack";
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
await executeImport(call, undefined, undefined, undefined, testPack.entries);
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
      targetLevel: "A2",
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
  const drawer = () =>
    page.evaluate(() => {
      const root = document.getElementById("voka-drawer")!.shadowRoot!;
      return {
        summary: root.querySelector(".drawer-toggle [role=status]")!
          .textContent,
        counts: [...root.querySelectorAll("[data-filter]")].map(
          (el) => el.textContent,
        ),
        words: [...root.querySelectorAll(".drawer-list button")].map((el) =>
          el.getAttribute("data-key"),
        ),
      };
    });
  assert.equal(
    await page.$eval(
      "#voka-drawer",
      (el) =>
        (el.shadowRoot!.querySelector(".drawer-body") as HTMLElement).hidden,
    ),
    true,
  );
  const initialDrawer = await drawer();
  assert.deepEqual(
    (await drawer()).counts.map((text) => Number(text!.match(/\d+$/)![0])),
    [4, 0, 1, 10],
  );
  assert.deepEqual((await drawer()).words, [
    "en:achieve",
    "en:afford",
    "en:improve",
    "en:encourage",
  ]);
  await page.evaluate(() =>
    (
      document
        .getElementById("voka-drawer")!
        .shadowRoot!.querySelector(".drawer-toggle") as HTMLElement
    ).click(),
  );
  await page.evaluate(() => {
    const root = document.getElementById("voka-drawer")!.shadowRoot!;
    (root.querySelector('[data-filter="missing"]') as HTMLElement).click();
  });
  assert.deepEqual((await drawer()).words, ["en:vokanonexistentlemma"]);
  await page.evaluate(() => {
    const root = document.getElementById("voka-drawer")!.shadowRoot!;
    (root.querySelector('[data-filter="target"]') as HTMLElement).click();
    document.body.style.paddingBottom = "1500px";
    window.scrollTo(0, 900);
    (root.querySelector('[data-key="en:achieve"]') as HTMLElement).click();
  });
  assert(
    await page.evaluate(
      () =>
        window.scrollY < 900 &&
        !(
          document
            .getElementById("voka-drawer")!
            .shadowRoot!.querySelector("#voka-card") as HTMLElement
        ).hidden &&
        document
          .getElementById("voka-drawer")!
          .shadowRoot!.querySelector("#voka-card h2")?.textContent ===
          "achieve",
    ),
  );
  await new Promise((r) => setTimeout(r, 1000));
  await mkdir("docs/research/drawer-evidence", { recursive: true });
  await page.screenshot({ path: "docs/research/drawer-evidence/expanded.png" });
  await page.evaluate(() =>
    (
      document
        .getElementById("voka-drawer")!
        .shadowRoot!.querySelector(".drawer-toggle") as HTMLElement
    ).click(),
  );
  await call(
    "notes.update",
    { id: original[1].id, patch: { fields: { ManualStatus: "known" } } },
    true,
  );
  await inject();
  await page.waitForFunction(() =>
    document
      .getElementById("voka-drawer")!
      .shadowRoot!.querySelector('[data-filter="target"]')!
      .textContent!.endsWith(" 3"),
  );
  await call(
    "notes.update",
    { id: original[1].id, patch: { fields: { ManualStatus: "unknown" } } },
    true,
  );
  await inject();
  await page.waitForFunction(() =>
    document
      .getElementById("voka-drawer")!
      .shadowRoot!.querySelector('[data-filter="target"]')!
      .textContent!.endsWith(" 4"),
  );
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
  await page.evaluate(() => {
    const root = document.getElementById("voka-drawer")!.shadowRoot!;
    const advanced = root.querySelector(
      '[name="showAdvanced"]',
    ) as HTMLInputElement;
    advanced.checked = true;
    advanced.dispatchEvent(new Event("change"));
    const hover = root.querySelector(
      '[name="hoverScope"]',
    ) as HTMLSelectElement;
    hover.value = "all";
    hover.dispatchEvent(new Event("change"));
  });
  await page.waitForFunction(() =>
    [...(CSS.highlights.get("voka-weak") ?? [])].some(
      (r) => r.toString() === "abandoning",
    ),
  );
  await hover("apple");
  assert.equal((await tip()).hidden, false);
  assert.deepEqual(
    await worker.evaluate(async () => {
      const s = await chrome.storage.local.get(["showAdvanced", "hoverScope"]);
      return [s.showAdvanced, s.hoverScope];
    }),
    [true, "all"],
  );
  await worker.evaluate(() =>
    chrome.storage.local.set({ targetLevel: "B1", showAdvanced: false }),
  );
  await page.waitForFunction(() =>
    [...(CSS.highlights.get("voka-target") ?? [])].some(
      (r) => r.toString() === "abandoning",
    ),
  );
  await worker.evaluate(() =>
    chrome.storage.local.set({ targetLevel: "A2", showAdvanced: true }),
  );
  await page.waitForFunction(() =>
    [...(CSS.highlights.get("voka-weak") ?? [])].some(
      (r) => r.toString() === "abandoning",
    ),
  );
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
        .shadowRoot!.querySelector(".drawer-toggle [role=status]")!
        .textContent!,
    ),
  );
  const summary = await page.evaluate(
    () =>
      document
        .getElementById("voka-drawer")!
        .shadowRoot!.querySelector(".drawer-toggle [role=status]")!.textContent,
  );
  assert.match(
    summary!,
    /^(VOKA 未运行：请检查 Anki|VOKA is not running: please check Anki)$/,
  );
  await page.screenshot({
    path: "docs/research/drawer-evidence/disconnected.png",
  });
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
        drawer: initialDrawer,
        summary,
        checks:
          "exclusions; unchanged text/HTML/layout; small imported fixture + real A2/B1 target; manual known/unknown; hover scope; advanced inflection; dynamic text + exclusion; disconnect clears all; reconnect; single host",
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
