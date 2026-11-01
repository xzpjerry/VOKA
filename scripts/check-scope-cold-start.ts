/** Real popup code after forced worker stop; local fixtures, read-only Anki 8766. */
import puppeteer from 'puppeteer';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
const server = createServer((_req, res) => res.end('<html lang="en"><p>The book was on the table.</p></html>'));
await new Promise<void>(r => server.listen(0, r));
const port = (server.address() as { port: number }).port;
const browser = await puppeteer.launch({ headless: false, enableExtensions: [resolve('dist')] });
try {
  const worker = (await (await browser.waitForTarget(t => t.type() === 'service_worker')).worker())!;
  const id = worker.url().split('/')[2];
  await worker.evaluate(() => chrome.storage.local.set({ port: 8766, siteScope: 'activeTab' }));
  const page = await browser.newPage();
  await page.goto(`http://cold.localhost:${port}/`);
  const extensions = await browser.newPage();
  await extensions.goto(`chrome://extensions/?id=${id}`);
  // Supplies host access in place of the native toolbar's activeTab grant.
  await extensions.evaluate(async extensionId => {
    await chrome.developerPrivate.addHostPermission(extensionId, '*://cold.localhost/*');
  }, id);
  await page.bringToFront();
  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id!);
  const popup = await browser.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.evaluate(() => {
    const button = document.createElement('button'); button.id = 'authorize';
    button.onclick = () => { void chrome.permissions.request({ origins: ['*://cold.localhost/*'] }).then(ok => button.dataset.ok = String(ok)); };
    document.body.append(button);
  });
  await popup.click('#authorize');
  await popup.waitForSelector('#authorize[data-ok="true"]');
  // A normal extension tab cannot be the active reading tab. Redirect only the
  // query in this test; all popup injection/permission/storage code is real.
  await popup.evaluateOnNewDocument(tabId => {
    const query = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = ((filter: chrome.tabs.QueryInfo) => filter.active
      ? chrome.tabs.get(tabId).then(tab => [tab]) : query(filter)) as typeof chrome.tabs.query;
  }, tabId);
  const oldTarget = browser.targets().find(t => t.type() === "service_worker")!;
  await worker.close();
  await new Promise(r => setTimeout(r, 500));
  assert(!browser.targets().includes(oldTarget), "worker target must be destroyed");
  await popup.reload();
  await popup.waitForSelector('#auto:not([disabled])');
  await page.waitForSelector('#voka-drawer');
  await popup.click('#auto');
  await popup.waitForFunction(() => (document.querySelector('#auto') as HTMLInputElement).checked && !(document.querySelector('#auto') as HTMLInputElement).disabled);
  assert(await popup.evaluate(async () => (await chrome.storage.local.get('rememberedSites')).rememberedSites.includes('cold.localhost')));
  await page.reload();
  await page.waitForSelector('#voka-drawer');
  assert.equal(await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'check-connection' })), 'ok');
  await page.waitForFunction(() => CSS.highlights.has('voka-target'));
  await popup.screenshot({ path: '/tmp/voka-popup-light.png', clip: { x: 0, y: 0, width: 336, height: 215 } });
  await popup.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await popup.screenshot({ path: '/tmp/voka-popup-dark.png', clip: { x: 0, y: 0, width: 336, height: 215 } });
  await popup.click('#pause');
  await page.waitForFunction(() => !CSS.highlights.has('voka-target'));
  // Preference changes must not resume a paused page.
  await popup.evaluate(() => chrome.storage.local.set({ showAdvanced: true }));
  await new Promise(r => setTimeout(r, 200));
  assert(!await page.evaluate(() => CSS.highlights.has('voka-target')));
  await popup.click('#auto');
  await popup.waitForFunction(async () => !(await chrome.permissions.contains({ origins: ['*://cold.localhost/*'] })));
  await page.reload();
  assert.equal(await page.$('#voka-drawer'), null);
  assert(!browser.targets().some(t => t.url().includes('remember.html')));
  console.log(JSON.stringify({ forcedWorkerStop: true, popupInjection: true, rememberReload: true, pauseClearsHighlights: true, offRevokesPermission: true, noConfirmationTab: true, limitations: ['Native toolbar click/activeTab grant replaced by host grant and redirected active-tab query.', 'Native Allow/Deny dialog pre-authorized through Chrome developerPrivate; trusted click runs real popup handler.'] }, null, 2));
} finally { await browser.close(); server.close(); }
