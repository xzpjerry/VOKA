/** Deterministic cold-cache acceptance, with read-only Anki traffic to 8766. */
import puppeteer from 'puppeteer';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { mkdir, writeFile, cp, mkdtemp, readFile, rm } from 'node:fs/promises';
const server = createServer((_req, res) => res.end('<html lang="en"><p>The book was on the table.</p></html>'));
await new Promise<void>(r => server.listen(0, r));
const port = (server.address() as { port: number }).port;
const fixtureDist = await mkdtemp('/tmp/voka-cold-scope-');
await cp(resolve('dist'), fixtureDist, { recursive: true });
const path = `${fixtureDist}/background.js`;
const source = await readFile(path, 'utf8');
const needle = 'chrome.storage.local.get({siteScope:"activeTab"})';
assert(source.includes(needle));
// Capture the actual product listener and keep its startup cache unready. The
// temporary host grant supplies injection access in place of toolbar activeTab;
// remove it immediately after injection, before the real recovery permission check.
const harness = `const listen = chrome.action.onClicked.addListener.bind(chrome.action.onClicked);
chrome.action.onClicked.addListener = fn => { globalThis.__toolbar = fn; listen(fn); };
const inject = chrome.scripting.executeScript.bind(chrome.scripting);
chrome.scripting.executeScript = async details => { const result = await inject(details); await chrome.permissions.remove({origins:['*://cold.localhost/*']}); return result; };
`;
await writeFile(path, harness + source.replace(needle, `new Promise(resolve => setTimeout(() => resolve(${needle}), 60000))`));
const browser = await puppeteer.launch({ headless: false, enableExtensions: [fixtureDist] });
try {
  let worker = (await (await browser.waitForTarget(t => t.type() === 'service_worker')).worker())!;
  const id = worker.url().split('/')[2];
  await worker.evaluate(() => chrome.storage.local.set({ port: 8766, siteScope: 'remembered' }));
  const page = await browser.newPage();
  await page.goto(`http://cold.localhost:${port}/`);
  const extensions = await browser.newPage();
  await extensions.goto(`chrome://extensions/?id=${id}`);
  await extensions.evaluate(async extensionId => {
    await chrome.developerPrivate.updateExtensionConfiguration({ extensionId, hostAccess: 'ON_CLICK' });
    await chrome.developerPrivate.addHostPermission(extensionId, '*://cold.localhost/*');
  }, id);
  const authorize = await browser.newPage();
  await authorize.goto(`chrome-extension://${id}/remember.html`);
  await authorize.evaluate(() => {
    const b = document.createElement('button'); b.id = 'authorize'; b.textContent = 'authorize';
    b.onclick = () => { void chrome.permissions.request({ origins: ['*://cold.localhost/*'] }).then(ok => { b.dataset.ok = String(ok); }); };
    document.body.append(b);
  });
  await authorize.bringToFront();
  await authorize.click('#authorize');
  await authorize.waitForSelector('#authorize[data-ok="true"]');
  const tabs = await worker.evaluate(() => chrome.tabs.query({}));
  const tab = tabs.find(t => t.url === page.url());
  assert(tab?.id);
  const oldTarget = browser.targets().find(t => t.type() === 'service_worker')!;
  // Puppeteer's close detaches its debugger session so Chrome really stops.
  await worker.close();
  await new Promise(r => setTimeout(r, 500));
  assert(!browser.targets().includes(oldTarget), 'old worker target must be destroyed');
  const wake = await browser.newPage();
  await wake.goto(`chrome-extension://${id}/remember.html`);
  await wake.evaluate(() => chrome.runtime.sendMessage({ type: 'check-connection' }));
  worker = (await (await browser.waitForTarget(t => t.type() === 'service_worker' && t !== oldTarget)).worker())!;
  await worker.evaluate(async tab => (globalThis as any).__toolbar(tab), tab);
  await page.waitForSelector('#voka-drawer', { timeout: 5000 });
  const promptTarget = await browser.waitForTarget(t => t.url() === `chrome-extension://${id}/remember.html?host=cold.localhost`);
  const prompt = (await promptTarget.page())!;
  await prompt.waitForSelector('#remember:not([disabled])');
  // Native Allow/Deny cannot be driven by Puppeteer. Use the real Chrome
  // site-access backend, then a trusted click on the actual product button.
  await extensions.evaluate(async extensionId => {
    await chrome.developerPrivate.addHostPermission(extensionId, '*://cold.localhost/*');
  }, id);
  await prompt.bringToFront();
  await prompt.click('#remember');
  await prompt.waitForFunction(() => document.querySelector('#status')?.textContent?.includes(chrome.i18n.getMessage('rememberSiteSaved')));
  await page.reload();
  await page.waitForSelector('#voka-drawer');
  const saved = await worker.evaluate(async () => ({ config: await chrome.storage.local.get(['rememberedSites']), scripts: await chrome.scripting.getRegisteredContentScripts() }));
  assert(saved.config.rememberedSites.includes('cold.localhost'));
  assert(saved.scripts.some(s => s.matches?.includes('*://cold.localhost/*')));
  await mkdir('docs/research/site-scope-cold-start-evidence', { recursive: true });
  await prompt.screenshot({ path: 'docs/research/site-scope-cold-start-evidence/confirmed.png' });
  const result = { chrome: await browser.version(), forcedStop: true, startupCacheDelayMs: 60000, action: 'Actual toolbar listener captured in temporary build, invoked after extension-message wake', promptOffered: true, productButtonClicked: true, autoRunOnReload: true, saved, limitations: ['Startup cache snapshot delayed in throwaway build to deterministically force the race.', 'Temporary host grant supplies injection access, then is removed before recovery; actual toolbar icon/activeTab UI not automated.', 'Native permission Allow/Deny replaced by Chrome developerPrivate authorization before clicking actual product button.'] };
  await writeFile('docs/research/site-scope-cold-start-evidence/results.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); server.close(); await rm(fixtureDist, { recursive: true, force: true }); }
