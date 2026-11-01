import puppeteer from "puppeteer";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadData } from "../src/data";
import { GatewayError, rpc } from "../src/background/gateway";
import { lookup, DEFAULT_TARGET } from "../src/background/import";
const rpcTraceEnabled = process.env.VOKA_RPC_LOG === "1";
async function call(method: string, params = {}, write = false): Promise<any> {
  const startedAt = Date.now();
  try {
    const result = await rpc({ port: 8766, apiKey: "" }, method, params, {
      sideEffecting: write,
    });
    if (rpcTraceEnabled)
      console.log(
        `[VOKA_SCRIPT_RPC] ${JSON.stringify({ method, startedAt: new Date(startedAt).toISOString(), durationMs: Date.now() - startedAt, outcome: "ok" })}`,
      );
    return result;
  } catch (error) {
    if (rpcTraceEnabled) {
      const outcome =
        error instanceof Error && error.name === "RpcTimeoutError"
          ? error instanceof GatewayError && error.outcome === "unknown"
            ? "timeout-unknown"
            : "timeout"
          : error instanceof GatewayError
            ? error.status
            : "error";
      console.log(
        `[VOKA_SCRIPT_RPC] ${JSON.stringify({ method, startedAt: new Date(startedAt).toISOString(), durationMs: Date.now() - startedAt, outcome })}`,
      );
    }
    throw error;
  }
}
const key = "en:apple";
const ids = (await lookup(call, DEFAULT_TARGET, [key])).get(key)!;
const original = ids.length
  ? (await call("notes.getMany", { ids })).items[0].result
  : undefined;
// Resolve by Key once; later assertions can verify the same note by its stable ID.
let cachedNoteId: string | undefined = original?.id;
const data = await loadData(async (name) =>
  JSON.parse(
    await readFile(
      new URL(`../public/data/${name}.json`, import.meta.url),
      "utf8",
    ),
  ),
);
const appleEntry = data.lookupEntry(key);
const manualEntry = data.lookupEntry("en:banana");
assert(["A1", "A2"].includes(manualEntry.level));
const manualKey = "en:" + manualEntry.lemma;
const manualBefore = (await lookup(call, DEFAULT_TARGET, [manualKey])).get(
  manualKey,
)!;
const beforeAppleLevel = (
  await call("notes.search", {
    query: "tag:voka::level::" + appleEntry.level,
    limit: 1000,
  })
).ids.length;
const levelBefore = (
  await call("notes.search", {
    query: "tag:voka::level::" + manualEntry.level,
    limit: 1000,
  })
).ids.length;
const sentences: Record<string, string> = {
  "/1": 'We shared a fresh <span id="word">apple</span> after lunch.',
  "/2": 'She picked an <span id="word">apple</span> from the tall tree.',
  "/3": 'They baked an <span id="word">apple</span> into a delicious pie.',
  "/4": 'Our neighbour brought an <span id="word">apple</span> for the picnic.',
  "/short": '<span id="word">apple</span> snack',
  "/footnote":
    'We shared[1] a fresh <span id="word">apple</span>¹ after lunch.',
  "/long":
    "Many people " +
    "read about fruit ".repeat(35) +
    '<span id="word">apple</span>' +
    " in the garden".repeat(35) +
    ".",
  "/manual": `People enjoy the <span id="word">${manualEntry.lemma}</span> after lunch.`,
  "/unknown":
    'We observed a <span id="word">vokacontextfixture</span> in the garden.',
};
const server = createServer((req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(
    `<!doctype html><title>Context ${req.url}</title><style>body{font:22px/1.7 Georgia;padding:40px;max-width:800px}a,button{margin:20px}</style><p id="sentence">${sentences[req.url!] || sentences["/1"]}</p><p>This change can <span id="highlight">benefit</span> the entire community.</p><a href="#clicked" id="link">benefit</a><button id="pagebutton" onclick="this.textContent='clicked'">benefit</button>`,
  );
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
const evidence = "docs/research/context-evidence";
await mkdir(evidence, { recursive: true });
let browser;
try {
  // Clear only this fixture's contexts for repeatability; restore pre-existing fields below.
  if (original)
    await call(
      "notes.update",
      {
        id: original.id,
        patch: {
          fields: {
            Context1: "",
            Source1: "",
            Context2: "",
            Source2: "",
            Context3: "",
            Source3: "",
            VokaMeta: "{}",
          },
        },
      },
      true,
    );
  browser = await puppeteer.launch({
    headless: false,
    enableExtensions: [resolve("dist")],
    args: ["--no-first-run"],
  });
  const workerTarget = await browser.waitForTarget(
    (t) => t.type() === "service_worker",
  );
  if (rpcTraceEnabled) {
    const trace = await workerTarget.createCDPSession();
    await trace.send("Runtime.enable");
    trace.on("Runtime.consoleAPICalled", (event) => {
      const message = event.args
        .map((argument) => argument.value ?? argument.description ?? "")
        .join(" ");
      if (message.includes("[VOKA_RPC]"))
        console.log(`[VOKA_SERVICE_WORKER] ${message}`);
    });
  }
  const worker = (await workerTarget.worker())!;
  await worker.evaluate(() =>
    chrome.storage.local.set({
      port: 8766,
      apiKey: "",
      targetLevel: "B1",
      nativeLanguage: "zh",
      glossLanguage: "native",
      storeFullUrl: false,
    }),
  );
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 1000 });
  const open = async (path: string) => {
    await page.goto(base + path);
    const tabId = await worker.evaluate(
      async (base) =>
        (await chrome.tabs.query({})).find((t) => t.url?.startsWith(base))!.id!,
      base,
    );
    await worker.evaluate(
      async (id) =>
        chrome.scripting.executeScript({
          target: { tabId: id },
          files: ["content.js"],
        }),
      tabId,
    );
    await page.waitForFunction(() => CSS.highlights.get("voka-target")?.size);
  };
  const click = async (id: string, count = 1) => {
    const box = (await (await page.$("#" + id))!.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, {
      count,
    });
  };
  const cardText = () =>
    page.evaluate(
      () =>
        document
          .getElementById("voka-drawer")!
          .shadowRoot!.querySelector("#voka-card")!.textContent!,
    );
  const visible = () =>
    page.evaluate(
      () =>
        !(
          document
            .getElementById("voka-drawer")!
            .shadowRoot!.querySelector("#voka-card") as HTMLElement
        ).hidden,
    );
  const cardButton = async (label: string) =>
    page.evaluate((label) => {
      const buttons = [
        ...document
          .getElementById("voka-drawer")!
          .shadowRoot!.querySelectorAll("#voka-card button"),
      ];
      const b = buttons.find(
        (b) => b.textContent === label,
      ) as HTMLButtonElement;
      if (!b || b.disabled) throw new Error("Missing enabled button " + label);
      b.click();
    }, label);
  const waitCard = (head = "apple") =>
    page.waitForFunction(
      (head) => {
        const root = document.getElementById("voka-drawer")!.shadowRoot!;
        const button = root.querySelector(
          "#voka-save-context",
        ) as HTMLButtonElement;
        return (
          button &&
          !button.disabled &&
          !(root.querySelector("#voka-card") as HTMLElement).hidden &&
          root.querySelector("#voka-card h2")?.textContent === head
        );
      },
      {},
      head,
    );
  const save = async () => {
    await page.evaluate(() =>
      (
        document
          .getElementById("voka-drawer")!
          .shadowRoot!.querySelector("#voka-save-context") as HTMLButtonElement
      ).click(),
    );
    await page.waitForFunction(
      () =>
        document
          .getElementById("voka-drawer")!
          .shadowRoot!.querySelector("#voka-card [role=status]")
          ?.textContent === "例句已保存",
    );
  };
  const read = async () => {
    if (!cachedNoteId) {
      const found = await call("notes.search", {
        query: `note:"${DEFAULT_TARGET.noteType}" ("Key:${key}")`,
        limit: 1000,
      });
      if (found.ids.length !== 1)
        throw new Error(`Expected one context note for ${key}; found ${found.ids.length}`);
      cachedNoteId = String(found.ids[0]);
    }
    const listVisible = await page.evaluate(() =>
      !!document
        .getElementById("voka-drawer")!
        .shadowRoot!.querySelector("#voka-context-list"),
    );
    if (!listVisible) await cardButton("查看例句 / ★ 置顶");
    const contexts = await page.evaluate(() =>
      [...document
        .getElementById("voka-drawer")!
        .shadowRoot!.querySelectorAll("#voka-context-list label")]
        .map((row) => ({
          text: row.querySelector(".sentence")?.textContent?.trim() ?? "",
          pinned: row.querySelector("button")?.textContent === "★",
        })),
    );
    return { id: cachedNoteId, contexts, pinned: contexts.some((c) => c.pinned) };
  };
  await open("/1");
  await click("word");
  assert.equal(await visible(), false);
  await click("link");
  assert.equal(await visible(), false);
  assert.equal(new URL(page.url()).hash, "#clicked");
  await click("pagebutton");
  assert.equal(await visible(), false);
  assert.equal(
    await page.$eval("#pagebutton", (e) => e.textContent),
    "clicked",
  );
  await click("highlight");
  await waitCard("benefit");
  assert.match(await cardText(), /benefit/);
  await page.keyboard.press("Escape");
  await click("word", 2);
  await waitCard();
  if (!original) assert.match(await cardText(), /加入 Anki（含这句例句）/);
  await save();
  let note = await read();
  assert(note.contexts[0]?.text.includes("fresh apple"));
  assert(note.contexts.every((context: any) => !context.text.includes(base)));
  if (!original) {
    const placed = await call("notes.search", {
      query: `note:"${DEFAULT_TARGET.noteType}" ("Key:${key}") tag:voka::level::${appleEntry.level} deck:"VOKA::English::${appleEntry.level}"`,
      limit: 10,
    });
    assert.equal(placed.ids.length, 1, "new context note must use its level deck and tag");
    const afterAppleLevel = await call("notes.search", {
      query: "tag:voka::level::" + appleEntry.level,
      limit: 1000,
    });
    assert.equal(afterAppleLevel.ids.length, beforeAppleLevel + 1);
  }
  // Pin it, edit it directly in Anki, and ensure a later save preserves the edit and clears the stale pin.
  await cardButton("☆");
  await page.waitForFunction(
    () =>
      document
        .getElementById("voka-drawer")!
        .shadowRoot!.querySelector("#voka-card [role=status]")?.textContent ===
      "置顶已更新",
  );
  note = await read();
  assert(note.pinned);
  const edited = "We shared a fresh <b>apple</b> after lunch, edited in Anki.";
  await call(
    "notes.update",
    { id: note.id, patch: { fields: { Context1: edited } } },
    true,
  );
  await open("/2");
  await click("word", 2);
  await waitCard();
  await save();
  note = await read();
  assert(note.contexts.some((context: any) => context.text.includes("edited in Anki")));
  assert.equal(note.pinned, false);
  await open("/3");
  await click("word", 2);
  await waitCard();
  await save();
  await open("/4");
  await click("word", 2);
  await waitCard();
  assert.match(await cardText(), /替换一条…/);
  await cardButton("替换一条…");
  const replacement = await page.evaluate(() => {
    const root = document.getElementById("voka-drawer")!.shadowRoot!;
    return [...root.querySelectorAll("#voka-context-list input")].map((e) => ({
      checked: (e as HTMLInputElement).checked,
      text: e.parentElement!.textContent,
    }));
  });
  assert.equal(replacement.length, 3);
  assert(replacement.find((r) => r.checked)?.text?.includes("edited in Anki"));
  await page.screenshot({ path: evidence + "/replacement.png" });
  // Choose the second row instead, preserving the Anki edit through the fourth save.
  await page.evaluate(() => {
    const radios = document
      .getElementById("voka-drawer")!
      .shadowRoot!.querySelectorAll("#voka-context-list input");
    (radios[1] as HTMLInputElement).click();
  });
  await cardButton("确认替换");
  await page.waitForFunction(
    () =>
      document
        .getElementById("voka-drawer")!
        .shadowRoot!.querySelector("#voka-card [role=status]")?.textContent ===
      "例句已保存",
  );
  note = await read();
  assert.equal(note.contexts.length, 3);
  assert(note.contexts.some((context: any) => context.text.includes("edited in Anki")));
  await page.screenshot({ path: evidence + "/saved.png" });
  await open("/4");
  await click("word", 2);
  await page.waitForFunction(
    () =>
      document
        .getElementById("voka-drawer")!
        .shadowRoot!.querySelector("#voka-save-context")?.textContent ===
      "这句已保存过",
  );
  await open("/short");
  await click("word", 2);
  await page.waitForFunction(() =>
    document
      .getElementById("voka-drawer")!
      .shadowRoot!.querySelector("#voka-card")
      ?.textContent?.includes("这句太短，换一句吧"),
  );
  await page.screenshot({ path: evidence + "/short.png" });
  await open("/long");
  await click("word", 2);
  await waitCard();
  assert.match(await cardText(), /…/);
  await cardButton("替换一条…");
  await cardButton("确认替换");
  await page.waitForFunction(
    () =>
      document
        .getElementById("voka-drawer")!
        .shadowRoot!.querySelector("#voka-card [role=status]")?.textContent ===
      "例句已保存",
  );
  note = await read();
  assert(note.contexts.some((context: any) => context.text.length < 320));
  assert(note.contexts.some((context: any) => context.text.includes("…")));
  await open("/footnote");
  await click("word", 2);
  await waitCard();
  assert(!/\[1\]|¹/.test(await cardText()));
  await cardButton("替换一条…");
  await cardButton("确认替换");
  await page.waitForFunction(
    () =>
      document
        .getElementById("voka-drawer")!
        .shadowRoot!.querySelector("#voka-card [role=status]")?.textContent ===
      "例句已保存",
  );
  await open("/1");
  await click("word", 2);
  await page.waitForFunction(
    () =>
      document
        .getElementById("voka-drawer")!
        .shadowRoot!.querySelector("#voka-save-context")?.textContent ===
      "这句已保存过",
  );
  await page.screenshot({ path: evidence + "/duplicate.png" });
  await open("/unknown");
  await click("word", 2);
  await waitCard("vokacontextfixture");
  assert.match(await cardText(), /词典没有/);
  await open("/manual");
  await click("word", 2);
  const createdManual = manualBefore.length === 0;
  if (createdManual) {
    await waitCard(manualEntry.lemma);
    assert.match(await cardText(), /加入 Anki（含这句例句）/);
    await save();
    const manualInTarget = await call("notes.search", {
      query: `note:"${DEFAULT_TARGET.noteType}" "Key:${manualKey}" tag:voka::level::${manualEntry.level} deck:"VOKA::English::${manualEntry.level}"`,
      limit: 10,
    });
    assert.equal(manualInTarget.ids.length, 1);
    assert.equal(
      (
        await call("notes.search", {
          query: "tag:voka::level::" + manualEntry.level,
          limit: 1000,
        })
      ).ids.length,
      levelBefore + 1,
    );
  }
  const options = await browser.newPage();
  await options.goto(
    await worker.evaluate(() => chrome.runtime.getURL("options.html")),
  );
  await options.waitForFunction(() => {
    const input = document.querySelector<HTMLInputElement>("#storeFullUrl");
    return input && !input.checked && !input.closest("fieldset")?.disabled;
  });
  await options.click("#storeFullUrl");
  await options.waitForFunction(
    async () =>
      (await chrome.storage.local.get("storeFullUrl")).storeFullUrl === true,
  );
  await options.click("#storeFullUrl");
  await options.waitForFunction(
    async () =>
      (await chrome.storage.local.get("storeFullUrl")).storeFullUrl === false,
  );
  await options.close();
  const result = {
    createdManual,
    manualKey,
    manualLevel: manualEntry.level,
    dataVersion: data.pack.version,
    browser: await browser.version(),
    port: 8766,
    createdApple: !original,
    noteId: note.id,
    replacement,
    contexts: note.contexts,
    checks: [
      "four pages, max three contexts",
      "Anki edit preserved across later saves, stale pin cleared",
      "replacement chooses oldest unpinned by default",
      "single click unhighlighted ignored; link and button preserved; single highlighted click opens",
      "context reopened in the drawer; short rejected; long window; footnotes removed; duplicate refused",
      "below-target add to its own real-data level deck without whole-level import; no full URL by default",
    ],
  };
  await writeFile(
    evidence + "/result.json",
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser?.close();
  server.close();
  if (original)
    await call(
      "notes.update",
      {
        id: original.id,
        patch: {
          fields: Object.fromEntries(
            [
              "Context1",
              "Source1",
              "Context2",
              "Source2",
              "Context3",
              "Source3",
              "VokaMeta",
            ].map((k) => [k, original.fields[k]]),
          ),
        },
      },
      true,
    );
}
