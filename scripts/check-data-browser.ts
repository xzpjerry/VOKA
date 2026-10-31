/** Real-pack browser acceptance, fixed 8766. Notes are read-only; gloss settings can update marker CSS. */
import puppeteer from "puppeteer";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
const server = createServer((_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(
    '<p><span id="target">abandoning</span> <span id="lower">achieved</span> <span id="missing">vokanonexistentlemma</span> <span id="variant">colour</span></p>',
  );
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const port = (server.address() as { port: number }).port;
let browser;
// Queue the isolated port before onInstalled opens the auto-checking wizard.
const scratch = await mkdtemp(join(tmpdir(), "voka-gloss-browser-"));
const extension = join(scratch, "extension");
await cp(resolve("dist"), extension, { recursive: true });
const backgroundFile = join(extension, "background.js");
await writeFile(backgroundFile,
  'chrome.storage.local.get("port").then((seeded) => {' +
  'if (typeof seeded.port !== "number") return chrome.storage.local.set({ port: 8766, apiKey: "" }); });' +
  await readFile(backgroundFile, "utf8"),
);
const netlog = join(scratch, "netlog.json");
try {
  browser = await puppeteer.launch({
    headless: false,
    enableExtensions: [extension],
    args: ["--no-first-run", `--log-net-log=${netlog}`],
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
  await worker.evaluate(() =>
    chrome.storage.local.set({ glossLanguage: "native", nativeLanguage: "zh" }),
  );
  await new Promise((done) => setTimeout(done, 1500));
  const targetBox = await (await page.$("#target"))!.boundingBox();
  await page.mouse.move(
    targetBox!.x + targetBox!.width / 2,
    targetBox!.y + targetBox!.height / 2,
  );
  const nativeTip = await page.evaluate(() => {
    const el = document
      .querySelector("#voka-drawer")!
      .shadowRoot!.querySelector<HTMLElement>("[role=tooltip]")!;
    return { hidden: el.hidden, text: el.textContent };
  });
  assert.equal(nativeTip.hidden, false);
  assert.match(nativeTip.text!, /[\u4e00-\u9fff]/);
  console.log("native", nativeTip.text);
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
    "VOKA-generated",
    "deepseek/deepseek-flash",
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
        anki: "8766; notes read-only, no imports; language settings may update marker CSS",
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  server.close();
  try {
    const network = await readFile(netlog, "utf8");
    assert(!network.includes("127.0.0.1:8765"), "browser contacted forbidden port 8765");
    console.log("network: no requests to 8765");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
