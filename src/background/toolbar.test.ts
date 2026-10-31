import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("./sites", async (importOriginal) => ({
  ...await importOriginal<typeof import("./sites")>(),
  scheduleSiteSync: vi.fn(async () => {}),
}));
let click: (tab: chrome.tabs.Tab) => Promise<void>;
let changed: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;
let get: ReturnType<typeof vi.fn>;
let request: ReturnType<typeof vi.fn>;
let inject: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  vi.resetModules();
  get = vi.fn(async () => ({ siteScope: "remembered" }));
  // A denied grant keeps this test focused on invocation, without later writes.
  request = vi.fn(async () => false);
  inject = vi.fn(async () => []);
  const event = () => ({ addListener: vi.fn() });
  vi.stubGlobal("chrome", {
    storage: {
      local: { get },
      onChanged: { addListener: (listener: typeof changed) => { changed = listener; } },
    },
    action: { onClicked: { addListener: (listener: typeof click) => { click = listener; } } },
    scripting: { executeScript: inject },
    permissions: { request, onAdded: event(), onRemoved: event() },
    runtime: { onMessage: event(), onStartup: event(), onInstalled: event() },
  });
  await import("./index");
  get.mockClear();
});
afterEach(() => vi.unstubAllGlobals());
const tab = { id: 42, url: "https://example.com/article" } as chrome.tabs.Tab;

it("requests remembered-site permission synchronously in the toolbar listener before storage or injection", async () => {
  const done = click(tab);
  // No await here: a storage await before request would leave this spy untouched.
  expect(request).toHaveBeenCalledWith({ origins: ["*://example.com/*"] });
  expect(get).not.toHaveBeenCalled();
  expect(request.mock.invocationCallOrder[0]).toBeLessThan(inject.mock.invocationCallOrder[0]);
  await done;
});

it("uses storage changes immediately without requesting access in manual mode", async () => {
  changed({ siteScope: { newValue: "activeTab" } }, "local");
  await click(tab);
  expect(request).not.toHaveBeenCalled();
  expect(inject).toHaveBeenCalledWith({ target: { tabId: 42 }, files: ["content.js"] });
  changed({ siteScope: { newValue: "remembered" } }, "local");
  const done = click(tab);
  expect(request).toHaveBeenCalledOnce();
  expect(get).not.toHaveBeenCalled();
  await done;
});

it("does not overwrite a newer scope change with a delayed startup snapshot", async () => {
  let resolveRead!: (value: { siteScope: string }) => void;
  get.mockImplementationOnce(() => new Promise((resolve) => { resolveRead = resolve; }));
  vi.resetModules();
  await import("./index");
  changed({ siteScope: { newValue: "remembered" } }, "local");
  resolveRead({ siteScope: "activeTab" });
  await Promise.resolve();
  get.mockClear();
  const done = click(tab);
  expect(request).toHaveBeenCalledOnce();
  expect(get).not.toHaveBeenCalled();
  await done;
});
