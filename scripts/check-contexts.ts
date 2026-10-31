import puppeteer from "puppeteer";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadData } from "../src/data";
import { rpc } from "../src/background/gateway";
import { lookup, DEFAULT_TARGET } from "../src/background/import";
const call = (method: string, params = {}, write = false) =>
  rpc({ port: 8766, apiKey: "" }, method, params, {
    sideEffecting: write,
  }) as Promise<any>;
const key = "en:apple";
const ids = (await lookup(call, DEFAULT_TARGET, [key])).get(key)!;
const original = ids.length
  ? (await call("notes.getMany", { ids })).items[0].result
  : undefined;
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
const beforeAppleLevel = (
  await call("notes.search", {
    query: "tag:voka::level::" + appleEntry.level,
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
  const worker = (await (
    await browser.waitForTarget((t) => t.type() === "service_worker")
  ).worker())!;
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
    const ids = (await lookup(call, DEFAULT_TARGET, [key])).get(key)!;
    return (await call("notes.getMany", { ids })).items[0].result;
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
  assert.match(note.fields.Context1, /<b>apple<\/b>/);
  assert(!note.fields.Source1.includes(base));
  const cards = (await call("cards.getMany", { ids: note.cardIds })).items.map(
    (i: any) => i.result,
  );
  if (!original) {
    assert(
      cards.every(
        (c: any) => c.deck.name === "VOKA::English::" + appleEntry.level,
      ),
    );
    assert(note.tags.includes("voka::level::" + appleEntry.level));
    assert.equal(
      (
        await call("notes.search", {
          query: "tag:voka::level::" + appleEntry.level,
          limit: 1000,
        })
      ).ids.length,
      beforeAppleLevel + 1,
    );
  } else {
    const originalCards = (
      await call("cards.getMany", { ids: original.cardIds })
    ).items.map((i: any) => i.result);
    assert.deepEqual(
      cards.map((c: any) => c.deck),
      originalCards.map((c: any) => c.deck),
    );
  }
  // Pin it, edit it directly in Anki, and ensure a later save preserves the edit and clears the stale pin.
  await cardButton("查看例句 / ★ 置顶");
  await cardButton("☆");
  await page.waitForFunction(
    () =>
      document
        .getElementById("voka-drawer")!
        .shadowRoot!.querySelector("#voka-card [role=status]")?.textContent ===
      "置顶已更新",
  );
  note = await read();
  assert(JSON.parse(note.fields.VokaMeta).pinnedContext);
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
  assert.equal(note.fields.Context2, edited);
  assert.equal(JSON.parse(note.fields.VokaMeta).pinnedContext, null);
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
  assert.equal([1, 2, 3].filter((i) => note.fields["Context" + i]).length, 3);
  assert([1, 2, 3].some((i) => note.fields["Context" + i] === edited));
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
  assert(note.fields.Context1.length < 320);
  assert.match(note.fields.Context1, /<b>apple<\/b>/);
  assert.match(note.fields.Context1, /…/);
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
  const manualKey = "en:" + manualEntry.lemma;
  const manualBefore = (await lookup(call, DEFAULT_TARGET, [manualKey])).get(
    manualKey,
  )!;
  const levelBefore = (
    await call("notes.search", {
      query: "tag:voka::level::" + manualEntry.level,
      limit: 1000,
    })
  ).ids.length;
  await open("/manual");
  await click("word", 2);
  const createdManual = manualBefore.length === 0;
  if (createdManual) {
    await waitCard(manualEntry.lemma);
    assert.match(await cardText(), /加入 Anki（含这句例句）/);
    await save();
    const manualIds = (await lookup(call, DEFAULT_TARGET, [manualKey])).get(
      manualKey,
    )!;
    assert.equal(manualIds.length, 1);
    const manual = (await call("notes.getMany", { ids: manualIds })).items[0]
      .result;
    assert(manual.tags.includes("voka::level::" + manualEntry.level));
    const manualCards = (
      await call("cards.getMany", { ids: manual.cardIds })
    ).items.map((i: any) => i.result);
    assert(
      manualCards.every(
        (c: any) => c.deck.name === "VOKA::English::" + manualEntry.level,
      ),
    );
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
    fields: note.fields,
    checks: [
      "four pages, max three contexts",
      "Anki edit preserved across later saves, stale pin cleared",
      "replacement chooses oldest unpinned by default",
      "single click unhighlighted ignored; link and button preserved; single highlighted click opens",
      "actual surface bold; short rejected; long window; footnotes removed; duplicate refused",
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
