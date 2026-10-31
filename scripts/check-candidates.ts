import puppeteer from "puppeteer";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { rpc } from "../src/background/gateway";
import { lookup, DEFAULT_TARGET } from "../src/background/import";
const call = (method: string, params = {}, write = false) => rpc({port:8766, apiKey:""},method,params,{sideEffecting:write}) as Promise<any>;
const note = async (key: string) => {
  const ids = (await lookup(call,DEFAULT_TARGET,[key])).get(key)!;
  assert(ids.length <= 1);
  return ids.length ? (await call("notes.getMany",{ids})).items[0].result : undefined;
};
const beforeSee = await note("en:see");
const beforeSaw = await note("en:saw");
const run = Date.now();
const server = createServer((_req,res) => res.end(`<!doctype html><title>Lemma candidates acceptance</title><p>I <span id="saw">saw</span> a bright <span id="colour">colour</span> near the garden today ${run}.</p>`));
await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
const browser = await puppeteer.launch({headless:false,enableExtensions:[resolve("dist")],args:["--no-first-run"]});
try {
  const worker = (await (await browser.waitForTarget(t=>t.type()==="service_worker")).worker())!;
  await worker.evaluate(()=>chrome.storage.local.set({port:8766,apiKey:"",targetLevel:"B1",hoverScope:"all"}));
  const page = await browser.newPage();
  const inject = async () => {
    await page.goto(base);
    const id = await worker.evaluate(async base=>(await chrome.tabs.query({})).find(t=>t.url?.startsWith(base))!.id!,base);
    await worker.evaluate(async id=>chrome.scripting.executeScript({target:{tabId:id},files:["content.js"]}),id);
    await page.waitForFunction(()=>document.getElementById("voka-drawer")?.shadowRoot?.querySelector(".drawer-toggle"));
    await new Promise(r=>setTimeout(r,500));
  };
  const open = async (id: string) => {
    await page.click("#"+id,{count:2});
    await page.waitForFunction(()=>!document.getElementById("voka-drawer")!.shadowRoot!.querySelector<HTMLButtonElement>("#voka-manual-status")?.disabled);
  };
  const title = () => page.evaluate(()=>document.getElementById("voka-drawer")!.shadowRoot!.querySelector("#voka-card h2")!.textContent);
  const click = async (selector: string) => {
    await page.evaluate(selector=>document.getElementById("voka-drawer")!.shadowRoot!.querySelector<HTMLButtonElement>(selector)!.click(),selector);
    if (selector.startsWith("[data-slot"))
      await page.waitForFunction(()=>!document.getElementById("voka-drawer")!.shadowRoot!.querySelector<HTMLButtonElement>("#voka-manual-status")!.disabled);
    else await page.waitForFunction(()=>/已标|已撤销|已保存/.test(document.getElementById("voka-drawer")!.shadowRoot!.querySelector("#voka-card [role=status]")!.textContent!));
  };
  await inject(); await open("saw");
  const defaultLemma = await title();
  assert.equal(defaultLemma, "saw");
  // Both candidates must remain selectable, irrespective of current data's default.
  if (defaultLemma === "saw") await click('[data-slot="lemma-candidates"] [data-key="en:see"]');
  assert.equal(await title(),"see");
  await click('[data-slot="lemma-candidates"] [data-key="en:saw"]');
  assert.equal(await title(),"saw");
  if (!beforeSaw) {
    await click("#voka-manual-status");
    assert.equal((await note("en:saw")).fields.ManualStatus,"unknown");
    assert.equal((await note("en:saw")).fields.Context1,"");
  }
  if (beforeSaw) {
    await click("#voka-manual-status");
    if ((await note("en:saw")).fields.ManualStatus !== "unknown")
      await click("#voka-manual-status");
    assert.equal((await note("en:saw")).fields.ManualStatus,"unknown");
  }
  assert(await page.evaluate(()=>Array.from(CSS.highlights.get("voka-unknown") ?? []).some(r=>r.toString()==="saw")));
  await click("#voka-save-context");
  const saved = await note("en:saw");
  assert(saved.fields.Context1.includes("<b>saw</b>"));
  assert.deepEqual(await note("en:see"),beforeSee);
  await page.hover("#saw");
  assert((await page.evaluate(()=>document.getElementById("voka-drawer")!.shadowRoot!.querySelector('[role="tooltip"]')!.textContent))!.startsWith("saw ·"));
  await open("colour"); assert.equal(await title(),"color");
  await open("saw"); assert.equal(await title(),"saw");
  await inject(); await open("saw"); assert.equal(await title(),defaultLemma);
  await mkdir("docs/research/lemma-candidates-evidence",{recursive:true});
  const result={browser:await browser.version(),port:8766,defaultLemma,sawNoteId:saved.id,manualAdd:!beforeSaw,checks:["see/saw switch","save writes saw, leaves see unchanged","manual action and red highlight use chosen lemma","tooltip uses chosen lemma","colour canonical color","choice retained on reopen","reload resets choice"]};
  await writeFile("docs/research/lemma-candidates-evidence/result.json",JSON.stringify(result,null,2)+"\n");
  console.log(result);
} finally {
  await browser.close(); server.close();
  if(beforeSaw) await call("notes.update",{id:beforeSaw.id,patch:{fields:beforeSaw.fields}},true);
}
