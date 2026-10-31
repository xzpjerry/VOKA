import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { rpc, checkConnection } from "../src/background/gateway.ts";
import { updateGlossCss, replaceGlossCss } from "../src/background/gloss.ts";
import { CORE_FIELDS, DEFAULT_TARGET } from "../src/background/import.ts";
import { css, questionHtml, answerHtml } from "../src/data/template.ts";
const config = { port: 8766, apiKey: "" };
assert.equal(await checkConnection(config), "ok");
const call = (method: string, params = {}, write = false): Promise<any> =>
  rpc(config, method, params, { sideEffecting: write });
const snapshot = () =>
  JSON.parse(
    execFileSync("python3", ["scripts/anki-snapshot.py"], { encoding: "utf8" }),
  );
const noteType = { name: DEFAULT_TARGET.noteType };
if (!(await call("noteTypes.list")).some((t: any) => t.name === noteType.name))
  await call(
    "noteTypes.create",
    {
      name: noteType.name,
      fields: CORE_FIELDS.map((name) => ({ name })),
      templates: [{ name: "词卡", questionHtml, answerHtml }],
      css,
      sortField: "Word",
    },
    true,
  );
const original = await call("noteTypes.get", { noteType });
const userCss =
  original.css + "\n/* T-26 user CSS */\n.user-custom{color:rebeccapurple}";
await call("noteTypes.update", { noteType, patch: { css: userCss } }, true);
const before = snapshot();
const notesBefore = await call("notes.search", {
  query: 'note:"VOKA Vocabulary · English"',
  limit: 1000,
});
const payloadBefore = await call("notes.getMany", { ids: notesBefore.ids });
const result: any = { port: 8766, modes: [] };
try {
  for (const mode of ["target", "native"] as const) {
    await updateGlossCss(call, mode);
    const current = await call("noteTypes.get", { noteType });
    assert.equal(current.css, replaceGlossCss(userCss, mode));
    const after = snapshot();
    assert.deepEqual(after, before);
    assert.deepEqual(
      await call("notes.getMany", { ids: notesBefore.ids }),
      payloadBefore,
    );
    result.modes.push({
      mode,
      scmBefore: before.scm,
      scmAfter: after.scm,
      outsideCssPreserved: true,
      notesAndSchedulingUnchanged: true,
    });
  }
  // Dedicated retained fixtures: create missing-gloss notes, never edit existing notes.
  const deck = { name: `VOKA::Gloss Acceptance ${Date.now()}` };
  await call("decks.create", deck, true);
  const notes = ["native", "target"].map((missing) => ({
    noteType,
    deck,
    tags: ["voka", "voka-test-gloss"],
    fields: {
      ...Object.fromEntries(CORE_FIELDS.map((f) => [f, ""])),
      Key: `en:gloss-test-${missing}-${Date.now()}`,
      Word: `missing ${missing}`,
      GlossNative: missing === "native" ? "" : "母语回退",
      GlossTarget: missing === "target" ? "" : "target fallback",
    },
  }));
  const valid = await call("notes.validateMany", { notes });
  assert(valid.items.every((i: any) => i.result.valid));
  const created = await call(
    "notes.createMany",
    { notes, atomic: false },
    true,
  );
  const { chromium } = await import(
    process.env.VOKA_PLAYWRIGHT ??
      "/Users/xzpjerry/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs"
  );
  const browser = await chromium.launch({
    executablePath:
      process.env.VOKA_CHROME ??
      `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
    headless: true,
  });
  result.browser = await browser.version();
  result.fallbacks = [];
  try {
    const page = await browser.newPage();
    for (let i = 0; i < 2; i++) {
      const mode = i === 0 ? "native" : "target";
      await updateGlossCss(call, mode);
      const render = await call("cards.render", {
        id: created.items[i].result.cardIds[0],
      });
      assert(!render.css.includes(":has("));
      await page.setContent(`<style>${render.css}</style>${render.answerHtml}`);
      const shown = await page
        .locator(i === 0 ? ".gloss-target" : ".gloss-native")
        .evaluate((el: Element) => ({
          text: el.textContent,
          display: getComputedStyle(el).display,
        }));
      assert.equal(shown.display, "block");
      result.fallbacks.push({
        mode,
        missing: i === 0 ? "native" : "target",
        cardId: render.cardId,
        ...shown,
        noHas: true,
      });
    }
  } finally {
    await browser.close();
  }
} finally {
  await call(
    "noteTypes.update",
    { noteType, patch: { css: original.css } },
    true,
  );
}
writeFileSync(
  "docs/research/gloss-switch-raw.json",
  JSON.stringify(result, null, 2) + "\n",
);
console.log(JSON.stringify(result, null, 2));
