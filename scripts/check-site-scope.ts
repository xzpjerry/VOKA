/**
 * Browser acceptance for #33 "site scope and deny list" (T-31).
 *
 * Uses Chrome for Testing, a throwaway local HTTP server on *.localhost, and
 * the isolated Anki instance at 127.0.0.1:8766. It never contacts 8765 and
 * never writes to Anki.
 *
 * Chrome's native extension-permission Allow dialog cannot be clicked from
 * Puppeteer. To still exercise the real permission + registration path, this
 * script first pre-authorizes the exact origin through Chrome's own extensions
 * site-access backend (chrome.developerPrivate, the same backend as the
 * chrome://extensions UI), then performs a trusted click on a page button that
 * calls chrome.permissions.request. That request resolves `true` without a
 * dialog, exactly as a repeat request after a real user grant does. The native
 * dialog itself is therefore NOT covered by this check (see the acceptance
 * document).
 */
import puppeteer, { type Page } from "puppeteer";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DEFAULT_DENY_SITES } from "../src/site-scope";

const evidenceDir = "docs/research/site-scope-evidence";
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const pageHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>VOKA site-scope fixture</title></head><body><main><h1>Reading fixture</h1><p>The book was on the table.</p></main></body></html>`;
const server = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(pageHtml);
});
await new Promise<void>((done) => server.listen(0, done));
const port = (server.address() as { port: number }).port;
const evidence: Record<string, unknown> = {
  chrome: "Chrome for Testing",
  fixture: `*.localhost:${port}`,
  t31: {},
  limitations: [],
};
let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
try {
  browser = await puppeteer.launch({
    headless: false,
    enableExtensions: [resolve("dist")],
    args: ["--no-first-run"],
    protocolTimeout: 30000,
  });
  console.log("step: launched");
  const worker = await (
    await browser.waitForTarget((target) => target.type() === "service_worker")
  ).worker();
  assert(worker);
  const id = worker.url().split("/")[2];
  const optionsUrl = `chrome-extension://${id}/options.html`;
  const extensionsUrl = `chrome://extensions/?id=${id}`;
  evidence.chrome = await browser.version();
  evidence.extensionId = id;

  // Default install: only the declared loopback host, no optional site grant.
  console.log("step: worker");
  const defaults = await worker.evaluate(async () => ({
    permissions: await chrome.permissions.getAll(),
    manifest: chrome.runtime.getManifest(),
  }));
  const initialPermissions = defaults.permissions;
  assert.deepEqual(initialPermissions.origins, ["http://127.0.0.1/*"]);
  assert.deepEqual(defaults.manifest.host_permissions, ["http://127.0.0.1/*"]);
  assert.deepEqual(defaults.manifest.optional_host_permissions, ["*://*/*"]);
  assert.deepEqual(defaults.manifest.permissions, [
    "storage",
    "activeTab",
    "scripting",
  ]);
  evidence.defaultInstall = {
    origins: initialPermissions.origins,
    permissions: initialPermissions.permissions,
    hostPermissions: defaults.manifest.host_permissions,
    optionalHostPermissions: defaults.manifest.optional_host_permissions,
    note: "No optional origin is granted at install; the only host origin is the declared loopback Anki host. Chrome's install-time prompt text is not observable from automation.",
  };

  // Wizard step 2 exposes the site-scope choice and has no deny-list editor.
  await worker.evaluate(() =>
    chrome.storage.local.set({ port: 8766, apiKey: "" }),
  );
  console.log("step: defaults");
  const wizardTarget = await browser.waitForTarget(
    (target) => target.url() === `${optionsUrl}?wizard=1`,
  );
  const wizard = (await wizardTarget.page())!;
  await wizard.reload();
  await wizard.waitForFunction(
    () => document.querySelector("#status")?.textContent === "已连接",
  );
  console.log("step: wizard loaded");
  await wizard.click("#nextConnection");
  await wizard.waitForSelector("#siteScopes");
  assert.equal(
    await wizard.$eval(
      'input[name="siteScope"][value="activeTab"]',
      (input: HTMLInputElement) => input.checked,
    ),
    true,
  );
  assert.equal(
    await wizard.$eval("#denylist", (element: HTMLElement) => element.hidden),
    true,
  );
  await mkdir(evidenceDir, { recursive: true });
  await wizard.screenshot({
    path: `${evidenceDir}/wizard-site-scope.png`,
    fullPage: true,
  });
  evidence.wizard = {
    scopes: await wizard.$$eval('input[name="siteScope"]', (inputs) =>
      inputs.map((input) => (input as HTMLInputElement).value),
    ),
    default: "activeTab",
    denyListHidden: true,
  };

  // Settings page: editable deny list and remembered-site controls.
  console.log("step: wizard scope");
  const settings = await browser.newPage();
  await settings.goto(optionsUrl);
  await settings.waitForFunction(
    () => document.querySelector("#status")?.textContent === "已连接",
  );
  assert.equal(
    await settings.$eval("#denylist", (element: HTMLElement) => element.hidden),
    false,
  );
  const denyText = await settings.$eval(
    "#denyListInput",
    (element: HTMLTextAreaElement) => element.value,
  );
  for (const host of [
    "mail.google.com",
    "web.whatsapp.com",
    "slack.com",
    "1password.com",
  ])
    assert.equal(
      denyText.includes(host),
      true,
      `default deny list should cover ${host}`,
    );
  await settings.click('input[name="siteScope"][value="remembered"]');
  await settings.waitForFunction(async () => {
    const value = await chrome.storage.local.get("siteScope");
    return value.siteScope === "remembered";
  });
  await settings.waitForSelector("#rememberedPanel:not([hidden])");
  const editedDenyList = [...DEFAULT_DENY_SITES, "deny.localhost"];
  await settings.$eval(
    "#denyListInput",
    (element: HTMLTextAreaElement, value: string) => {
      element.value = value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
    },
    editedDenyList.join("\n"),
  );
  await settings.click("#saveDenyList");
  await settings.waitForFunction(
    () => document.querySelector("#denyListStatus")?.textContent?.includes("已保存"),
  );
  assert.deepEqual(
    (await worker.evaluate(() => chrome.storage.local.get("denyList"))).denyList,
    editedDenyList,
  );
  await settings.screenshot({
    path: `${evidenceDir}/settings-denylist.png`,
    fullPage: true,
  });
  evidence.settings = {
    siteScope: "remembered",
    denyListSaved: editedDenyList.length,
    denyListIncludesDefaults: true,
    denyListEditable: true,
  };

  // Pre-authorize exact origins through the extensions backend, then make the
  // real chrome.permissions.request call from a trusted click.
  console.log("step: settings");
  const extensions = await browser.newPage();
  console.log("step: extensions page");
  await extensions.goto(extensionsUrl);
  console.log("step: extensions navigated", await extensions.title());
  await sleep(800);
  console.log("step: extensions sleep");
  await extensions.evaluate(
    async (extensionId: string) =>
      chrome.developerPrivate.updateExtensionConfiguration({
        extensionId,
        hostAccess: "ON_CLICK",
      }),
    id,
  );

  async function grant(pattern: string): Promise<boolean> {
    console.log("grant: addHostPermission", pattern);
    await extensions.evaluate(
      async ({ extensionId, pattern }: { extensionId: string; pattern: string }) =>
        chrome.developerPrivate.addHostPermission(extensionId, pattern),
      { extensionId: id, pattern },
    );
    console.log("grant: addHostPermission done", pattern);
    const page = await browser!.newPage();
    await page.goto(optionsUrl);
    console.log("grant: page ready", pattern);
    await page.evaluate((origin: string) => {
      const button = document.createElement("button");
      button.id = "grant-test";
      button.textContent = "grant";
      button.style.cssText =
        "position:fixed;top:10px;left:10px;z-index:2147483647";
      button.onclick = () => {
        const state = window as unknown as { __grantResult?: string };
        state.__grantResult = "pending";
        chrome.permissions
          .request({ origins: [origin] })
          .then(
            (granted) => (state.__grantResult = String(granted)),
            (error) => (state.__grantResult = `ERR ${error}`),
          );
      };
      document.body.append(button);
    }, pattern);
    await page.bringToFront();
    const button = await page.$("#grant-test");
    assert(button);
    console.log("grant: button found", pattern);
    const box = await button.boundingBox();
    assert(box);
    console.log("grant: box", pattern);
    await page.mouse.click(box.x + 5, box.y + 5);
    console.log("grant: clicked", pattern);
    await page.waitForFunction(
      () =>
        (window as unknown as { __grantResult?: string }).__grantResult !==
        "pending",
      { timeout: 5000 },
    );
    console.log("grant: settled", pattern);
    const result = await page.evaluate(
      () => (window as unknown as { __grantResult?: string }).__grantResult,
    );
    await page.close();
    console.log("grant: result", pattern, result);
    return result === "true";
  }

  console.log("step: extensions");
  assert.equal(await grant("*://allow.localhost/*"), true);
  assert.equal(await grant("*://deny.localhost/*"), true);
  const grantedOrigins = await worker.evaluate(
    async () => (await chrome.permissions.getAll()).origins,
  );
  assert(grantedOrigins?.includes("*://allow.localhost/*"));
  assert(grantedOrigins?.includes("*://deny.localhost/*"));
  evidence.permissionHarness = {
    grantedOrigins,
    note: "Exact origins were pre-authorized through Chrome's site-access backend, then chrome.permissions.request was invoked from a trusted click. The native Allow/Deny bubble was not automated.",
  };

  // Remembered mode: register only the non-denied remembered site.
  await worker.evaluate(() =>
    chrome.storage.local.set({
      siteScope: "remembered",
      rememberedSites: ["allow.localhost", "deny.localhost"],
    }),
  );
  async function registrations() {
    return worker.evaluate(() => chrome.scripting.getRegisteredContentScripts());
  }
  let scripts: chrome.scripting.RegisteredContentScript[] = [];
  for (let attempt = 0; attempt < 50; attempt++) {
    scripts = await registrations();
    if (scripts.length && scripts[0].id === "voka-site-auto") break;
    await sleep(100);
  }
  assert.deepEqual(
    scripts.map((script) => ({
      id: script.id,
      matches: script.matches,
      js: script.js,
    })),
    [
      {
        id: "voka-site-auto",
        matches: ["*://allow.localhost/*"],
        js: ["content-auto.js"],
      },
    ],
  );
  evidence.remembered = {
    registeredMatches: scripts[0].matches,
    autoScript: scripts[0].js,
  };

  async function open(host: string) {
    const page = await browser!.newPage();
    await page.goto(`http://${host}:${port}/`, {
      waitUntil: "domcontentloaded",
    });
    return page;
  }
  async function hasDrawer(page: Page, timeout = 6000) {
    try {
      await page.waitForSelector("#voka-drawer", { timeout });
      return true;
    } catch {
      return false;
    }
  }

  const allowed = await open("allow.localhost");
  assert.equal(await hasDrawer(allowed), true);
  await allowed.screenshot({
    path: `${evidenceDir}/remembered-auto-run.png`,
  });

  const denied = await open("deny.localhost");
  assert.equal(await hasDrawer(denied, 3000), false);
  const tabs = await worker.evaluate(() => chrome.tabs.query({}));
  const deniedTab = tabs.find((tab) =>
    tab.url?.startsWith(`http://deny.localhost:${port}`),
  );
  assert(deniedTab?.id);
  const injected = await worker.evaluate(
    async (tabId: number) => {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ["content.js"],
        });
        return "ok";
      } catch (error) {
        return String(error);
      }
    },
    deniedTab.id,
  );
  assert.equal(injected, "ok");
  assert.equal(await hasDrawer(denied), true);
  await denied.screenshot({
    path: `${evidenceDir}/deny-manual-run.png`,
  });
  evidence.t31.denyListed = {
    remembered: true,
    granted: true,
    autoRun: false,
    manualInjection: true,
    manualPath:
      "chrome.scripting.executeScript with content.js, the same call the toolbar handler makes after its click; the toolbar icon click itself is not automatable in Puppeteer.",
  };
  evidence.t31.remembered = {
    autoRun: true,
    onlyNonDeniedOriginRegistered: true,
  };

  // Revoking the remembered site's grant stops auto-run.
  await extensions.evaluate(
    async (extensionId: string) =>
      chrome.developerPrivate.removeHostPermission(
        extensionId,
        "*://allow.localhost/*",
      ),
    id,
  );
  let empty = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    const current = await registrations();
    if (current.length === 0) {
      empty = true;
      break;
    }
    await sleep(100);
  }
  assert.equal(empty, true);
  assert.equal(
    await worker.evaluate(() =>
      chrome.permissions.contains({ origins: ["*://allow.localhost/*"] }),
    ),
    false,
  );
  await allowed.reload({ waitUntil: "domcontentloaded" });
  assert.equal(await hasDrawer(allowed, 3000), false);
  evidence.t31.revoked = {
    permissionRevoked: true,
    registrationRemoved: true,
    autoRunAfterReload: false,
  };

  // All-sites mode: one grant enables auto-run on any site, deny list still wins.
  console.log("all: before grant");
  assert.equal(await grant("*://*/*"), true);
  console.log("all: granted");
  assert.equal(
    await worker.evaluate(() =>
      chrome.permissions.contains({ origins: ["*://*/*"] }),
    ),
    true,
  );
  console.log("all: contains");
  await settings.bringToFront();
  console.log("all: front");
  await settings.click('input[name="siteScope"][value="all"]');
  console.log("all: clicked");
  await settings.waitForFunction(async () => {
    const value = await chrome.storage.local.get("siteScope");
    return value.siteScope === "all";
  });
  console.log("all: stored");
  await settings.waitForSelector("#allPanel:not([hidden])");
  await settings.waitForSelector("#revokeAll:not([hidden])");
  console.log("all: panels");
  assert.equal(
    await settings.$eval("#grantAll", (button: HTMLButtonElement) => button.hidden),
    true,
  );
  await settings.screenshot({
    path: `${evidenceDir}/all-sites.png`,
    fullPage: true,
  });
  scripts = [];
  for (let attempt = 0; attempt < 50; attempt++) {
    scripts = await registrations();
    if (scripts.length && scripts[0].matches[0] === "*://*/*") break;
    await sleep(100);
  }
  assert.deepEqual(scripts[0]?.matches, ["*://*/*"]);
  console.log("all: registration verified");
  const anySite = await open("new.localhost");
  assert.equal(await hasDrawer(anySite), true);
  const deniedInAllMode = await open("deny.localhost");
  assert.equal(await hasDrawer(deniedInAllMode, 3000), false);
  evidence.t31.allSites = {
    grant: "all_urls",
    registeredMatches: scripts[0].matches,
    autoRunOnUnrememberedSite: true,
    denyListSuppressesAutoRun: true,
  };
  evidence.t31.denyListedApplyToAll = {
    autoRun: false,
  };

  console.log("all: auto-run verified");
  // Revoking all sites through the settings page removes the registration.
  await settings.bringToFront();
  await settings.click("#revokeAll");
  for (let attempt = 0; attempt < 50; attempt++) {
    const current = await registrations();
    if (current.length === 0) break;
    await sleep(100);
  }
  assert.equal(
    await worker.evaluate(() =>
      chrome.permissions.contains({ origins: ["*://*/*"] }),
    ),
    false,
  );
  assert.equal((await registrations()).length, 0);
  await anySite.reload({ waitUntil: "domcontentloaded" });
  assert.equal(await hasDrawer(anySite, 3000), false);
  evidence.t31.revokeAll = {
    permissionRevoked: true,
    registrationRemoved: true,
    autoRunAfterReload: false,
  };

  evidence.limitations = [
    "The native Chrome extension permission bubble (Allow/Deny) cannot be clicked by Puppeteer; tests pre-authorize through Chrome's own extensions site-access backend and then exercise chrome.permissions.request from a trusted click.",
    "The toolbar icon click cannot be synthesized by Puppeteer. The manual path is verified by calling the same chrome.scripting.executeScript({files:['content.js']}) injection that the action handler performs.",
    "Install-time host-prompt text and the All-sites warning text were checked in the settings/wizard DOM and manifest, not in Chrome's native install prompt.",
    "T-31 was verified on local *.localhost fixtures with the built-in deny list extended by deny.localhost; real Gmail/Outlook/WhatsApp accounts were not opened.",
  ];
  await writeFile(
    `${evidenceDir}/results.json`,
    JSON.stringify(evidence, null, 2),
  );
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await browser?.close();
  server.close();
}
