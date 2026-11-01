// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
let config: Record<string, unknown>;
let request: ReturnType<typeof vi.fn>;
let inject: ReturnType<typeof vi.fn>;
let remove: ReturnType<typeof vi.fn>;
const settle = async () => { await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('#auto')!.disabled).toBe(false)); };
beforeEach(async () => {
  vi.resetModules();
  document.body.innerHTML = '<h1 id="host"></h1><p id="status"></p><input id="auto" type="checkbox" disabled><span id="autoLabel"></span><p id="blocked"></p><button id="removeDeny"></button><p id="feedback"></p><button id="pause"></button><button id="options"></button>';
  config = { siteScope: 'activeTab', rememberedSites: [], denyList: [] };
  request = vi.fn(async () => true);
  remove = vi.fn(async () => true);
  inject = vi.fn(async () => []);
  vi.stubGlobal('chrome', {
    i18n: { getMessage: (key: string) => key },
    tabs: { query: vi.fn(async () => [{ id: 42, url: 'https://example.com/' }]), sendMessage: vi.fn(async () => ({ ok: true })) },
    runtime: { openOptionsPage: vi.fn(async () => {}) },
    storage: { local: { get: vi.fn(async defaults => ({ ...defaults, ...config })), set: vi.fn(async changes => Object.assign(config, changes)) } },
    permissions: { request, remove, contains: vi.fn(async () => true), getAll: vi.fn(async () => ({ origins: [] })) },
    scripting: { executeScript: inject, getRegisteredContentScripts: vi.fn(async () => []), registerContentScripts: vi.fn(async () => {}) },
  });
});
afterEach(() => vi.unstubAllGlobals());
it('injects immediately without requesting permission and requests synchronously on toggle click', async () => {
  await import('./popup'); await settle();
  expect(inject).toHaveBeenCalledWith({ target: { tabId: 42 }, files: ['content.js'] });
  expect(request).not.toHaveBeenCalled();
  document.querySelector<HTMLInputElement>('#auto')!.click();
  expect(request).toHaveBeenCalledWith({ origins: ['*://example.com/*'] });
  await settle();
  expect(config.siteScope).toBe('remembered');
  expect(config.rememberedSites).toEqual(['example.com']);
  document.querySelector<HTMLInputElement>('#auto')!.click();
  await settle();
  expect(config.rememberedSites).toEqual([]);
  expect(remove).toHaveBeenCalledWith({ origins: ['*://example.com/*'] });
});
it('keeps deny-listed manual injection available and disables automatic toggle', async () => {
  config.denyList = ['example.com'];
  await import('./popup');
  await vi.waitFor(() => expect(document.querySelector('#status')!.textContent).toBe('popupDenied'));
  expect(inject).toHaveBeenCalledOnce();
  expect(document.querySelector<HTMLInputElement>('#auto')!.disabled).toBe(true);
  expect(request).not.toHaveBeenCalled();
  document.querySelector<HTMLButtonElement>('#removeDeny')!.click();
  await settle();
  expect(config.denyList).toEqual([]);
});
it('does not remember a denied permission request', async () => {
  request.mockResolvedValue(false);
  await import('./popup'); await settle();
  document.querySelector<HTMLInputElement>('#auto')!.click(); await settle();
  expect(config.siteScope).toBe('activeTab');
  expect(config.rememberedSites).toEqual([]);
  expect(document.querySelector('#feedback')!.textContent).toBe('popupPermissionDenied');
});
it('reports protected injection failure and disables page actions', async () => {
  inject.mockRejectedValue(new Error('protected'));
  await import('./popup');
  await vi.waitFor(() => expect(document.querySelector('#status')!.textContent).toBe('popupUnsupported'));
  expect(document.querySelector<HTMLInputElement>('#auto')!.disabled).toBe(true);
  expect(document.querySelector<HTMLButtonElement>('#pause')!.disabled).toBe(true);
});
