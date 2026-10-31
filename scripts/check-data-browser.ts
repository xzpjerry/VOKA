/** Real-pack browser acceptance. Anki API operations are read-only, fixed 8766. */
import puppeteer from "puppeteer";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
const server = createServer((_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(
    '<p><span id="target">abandoning</span> <span id="lower">achieved</span> <span id="missing">vokanonexistentlemma</span> <span id="variant">colour</span></p>',
  );
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const port = (server.address() as { port: number }).port;
let browser;
try {
  browser = await puppeteer.launch({
    headless: false,
    enableExtensions: [resolve("dist")],
    args: ["--no-first-run"],
  });
  const worker = (await (
    await browser.waitForTarget((t) => t.type() === "service_worker")
  ).worker())!;
  await worker.evaluate(() =>
    chrome.storage.local.set({
      port: 8766,
      apiKey: "",
      targetLevel: "B1",
      hoverScope: "all",
      showAdvanced: false,
      glossLanguage: "target",
    }),
  );
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}`);
  const tabId = await worker.evaluate(
    async (port) =>
      (await chrome.tabs.query({})).find((t) =>
        t.url?.includes(`127.0.0.1:${port}`),
      )!.id!,
    port,
  );
  await worker.evaluate(
    (id) =>
      chrome.scripting.executeScript({
        target: { tabId: id },
        files: ["content.js"],
      }),
    tabId,
  );
  await page.waitForFunction(() =>
    [...(CSS.highlights.get("voka-target") ?? [])].some(
      (range) => range.toString() === "abandoning",
    ),
  );
  const highlights = await page.evaluate(() =>
    Object.fromEntries(
      [...CSS.highlights].map(([key, value]) => [
        key,
        [...value].map((range) => range.toString()),
      ]),
    ),
  );
  assert(!highlights["voka-target"].includes("achieved")); // achieve is A2 in the real source.
  for (const [id, pattern] of [
    ["target", /abandon/i],
    ["missing", /词典没有|Not in dictionary/i],
    ["variant", /color|colour/i],
  ] as const) {
    const box = await (await page.$(`#${id}`))!.boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    const tip = await page.evaluate(() => {
      const el = document
        .querySelector("#voka-drawer")!
        .shadowRoot!.querySelector<HTMLElement>("[role=tooltip]")!;
      return { hidden: el.hidden, text: el.textContent };
    });
    assert.equal(tip.hidden, false);
    assert.match(tip.text!, pattern);
    console.log(id, tip.text);
  }
  const extensionId = worker.url().split("/")[2];
  const options = await browser.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.waitForFunction(() =>
    document.body.textContent?.includes("Princeton"),
  );
  const text = await options.$eval("main", (el) => el.textContent!);
  for (const source of [
    "CEFR-J",
    "Octanove",
    "Open English WordNet",
    "Carnegie Mellon",
    "Princeton",
  ])
    assert(text.includes(source));
  const heading = await options.$$eval("h2", (els) =>
    els.map((el) => el.textContent),
  );
  assert(heading.some((text) => /关于|About/.test(text!)));
  await mkdir("docs/research/data-evidence", { recursive: true });
  await options.screenshot({
    path: "docs/research/data-evidence/about.png",
    fullPage: true,
  });
  console.log(
    JSON.stringify(
      {
        browser: await browser.version(),
        highlights,
        attributions: "all sources and complete notices present",
        anki: "8766 read-only; no imports",
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  server.close();
}
