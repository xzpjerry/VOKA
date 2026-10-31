import puppeteer from "puppeteer";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const assets = new Map<string, string>();
for (const [path, url] of [
  ["/react.js", "https://unpkg.com/react@18.3.1/umd/react.production.min.js"],
  [
    "/react-dom.js",
    "https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js",
  ],
]) {
  const response = await fetch(url);
  assert(response.ok);
  assets.set(path, await response.text());
}
const server = createServer(async (req, res) => {
  res.setHeader(
    "Content-Type",
    assets.has(req.url!) ? "text/javascript" : "text/html",
  );
  res.end(
    assets.get(req.url!) ??
      (await readFile(new URL("./dynamic-fixture.html", import.meta.url))),
  );
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
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
      showAdvanced: false,
    }),
  );
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 950 });
  await page.goto(`http://127.0.0.1:${(server.address() as any).port}`);
  await page.waitForSelector('p[data-id="1999"]');
  const geometry = () =>
    page.$eval("main", (el) => ({
      html: el.innerHTML,
      rect: JSON.stringify(el.getBoundingClientRect()),
    }));
  const before = await geometry();
  await page.evaluate(() => {
    (window as any).tasks = [];
    new PerformanceObserver((list) =>
      (window as any).tasks.push(
        ...list
          .getEntries()
          .map((e) => ({ start: e.startTime, duration: e.duration })),
      ),
    ).observe({ type: "longtask" });
  });
  const tabId = await worker.evaluate(
    async () =>
      (await chrome.tabs.query({})).find((t) =>
        t.url?.startsWith("http://127.0.0.1:"),
      )!.id!,
  );
  const start = performance.now();
  await worker.evaluate(
    (id) =>
      chrome.scripting.executeScript({
        target: { tabId: id },
        files: ["content.js"],
      }),
    tabId,
  );
  await page.waitForFunction(
    () => CSS.highlights.get("voka-target")?.size === 8000,
    { timeout: 30000 },
  );
  const initialMs = performance.now() - start;
  assert.deepEqual(await geometry(), before);
  const initialTasks = await page.evaluate(() => (window as any).tasks);
  const scroll = await page.evaluate(async () => {
    (window as any).tasks = [];
    const deltas: number[] = [];
    let last = performance.now();
    for (let i = 0; i < 180; i++) {
      await new Promise<void>((r) =>
        requestAnimationFrame((now) => {
          deltas.push(now - last);
          last = now;
          scrollTo(0, i * 350);
          r();
        }),
      );
    }
    return {
      longTasks: (window as any).tasks,
      frames: deltas.length,
      maxFrameMs: Math.max(...deltas),
      framesOver50ms: deltas.filter((t) => t > 50).length,
    };
  });
  await page.evaluate(() => {
    scrollTo(0, 0);
    (window as any).retained = [...CSS.highlights.get("voka-target")!].find(
      (r) => r.startContainer.parentElement?.getAttribute("data-id") === "1",
    );
    (window as any).appendParagraph();
  });
  await page.waitForFunction(
    () => CSS.highlights.get("voka-target")?.size === 8002,
  );
  await page.evaluate(() => (window as any).replaceParagraph());
  await page.waitForFunction(
    () => CSS.highlights.get("voka-target")?.size === 8000,
  );
  assert(
    await page.evaluate(() =>
      CSS.highlights.get("voka-target")!.has((window as any).retained),
    ),
  );
  await page.evaluate(() => (window as any).removeParagraph());
  await page.waitForFunction(
    () => CSS.highlights.get("voka-target")?.size === 7998,
  );
  assert(
    await page.evaluate(() =>
      [...CSS.highlights.get("voka-target")!].every(
        (r) => r.startContainer.isConnected && r.toString().length > 0,
      ),
    ),
  );
  const after = await geometry();
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(await geometry(), after);
  const result = {
    browser: await browser.version(),
    paragraphs: 2000,
    initialMs,
    initialLongTasks: initialTasks,
    scroll,
    checks:
      "React append/replace/remove; 8000 initial ranges; unchanged initial HTML/layout; retained unaffected Range identity; no detached/empty ranges; no duplicate processing",
  };
  await writeFile(
    "docs/research/dynamic-performance.json",
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser?.close();
  server.close();
}
