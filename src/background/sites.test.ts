import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { rememberSite, scheduleSiteSync, shouldAutoRun } from "./sites";

let config: Record<string, unknown>;
let granted: boolean;
let request: ReturnType<typeof vi.fn>;
let register: ReturnType<typeof vi.fn>;
let unregister: ReturnType<typeof vi.fn>;
let registered: Array<Record<string, unknown>>;
beforeEach(() => {
  config = { siteScope: "remembered", rememberedSites: ["example.com"], denyList: ["mail.google.com"] };
  granted = true;
  request = vi.fn(async () => granted);
  registered = [];
  register = vi.fn(async (scripts: Array<Record<string, unknown>>) => {
    registered.push(...scripts);
  });
  unregister = vi.fn(async ({ ids }: { ids: string[] }) => {
    registered = registered.filter((script) => !ids.includes(String(script.id)));
  });
  vi.stubGlobal("chrome", {
    storage: { local: {
      get: vi.fn(async (defaults) => ({ ...defaults, ...config })),
      set: vi.fn(async (changes) => Object.assign(config, changes)),
    } },
    permissions: {
      request,
      contains: vi.fn(async () => granted),
      getAll: vi.fn(async () => ({ origins: ["*://*/*"] })),
    },
    scripting: {
      getRegisteredContentScripts: vi.fn(async () => registered),
      registerContentScripts: register,
      unregisterContentScripts: unregister,
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

it("requests permission immediately and only remembers an accepted grant", async () => {
  granted = false;
  const pending = rememberSite("new.example");
  expect(request).toHaveBeenCalledWith({ origins: ["*://new.example/*"] });
  expect(await pending).toBe(false);
  expect(config.rememberedSites).toEqual(["example.com"]);
  granted = true;
  expect(await rememberSite("new.example")).toBe(true);
  expect(config.rememberedSites).toEqual(["example.com", "new.example"]);
});

it("blocks denied auto-runs despite a remembered grant", async () => {
  config.rememberedSites = ["mail.google.com"];
  expect(await shouldAutoRun("https://mail.google.com/mail/")).toBe(false);
  expect(await shouldAutoRun("chrome://extensions")).toBe(false);
});

it("checks live permission before each auto-run", async () => {
  expect(await shouldAutoRun("https://example.com/")).toBe(true);
  granted = false;
  expect(await shouldAutoRun("https://example.com/")).toBe(false);
});

it("registers remembered sites covered by a broader grant", async () => {
  await scheduleSiteSync();
  expect(register).toHaveBeenCalledWith([expect.objectContaining({
    matches: ["*://example.com/*"], persistAcrossSessions: true,
  })]);
  config.siteScope = "activeTab";
  register.mockClear();
  await scheduleSiteSync();
  expect(register).not.toHaveBeenCalled();
});

it("registers the YouTube MAIN hook early only while YouTube is remembered", async () => {
  config.rememberedSites = ["www.youtube.com"];
  await scheduleSiteSync();
  const scripts = register.mock.calls[0][0];
  expect(scripts).toContainEqual(expect.objectContaining({
    id: "voka-youtube-main",
    matches: ["https://www.youtube.com/*"],
    js: ["youtube-main.js"],
    runAt: "document_start",
    world: "MAIN",
    allFrames: false,
  }));

  const remove = vi.fn(async () => true);
  (chrome.permissions as unknown as { remove: typeof remove }).remove = remove;
  await forgetRememberedYouTube();
  expect(unregister).toHaveBeenCalledWith({ ids: expect.arrayContaining(["voka-youtube-main"]) });
});

it("registers the YouTube MAIN hook in all-sites mode unless YouTube is denied", async () => {
  config.siteScope = "all";
  config.rememberedSites = [];
  await scheduleSiteSync();
  expect(register.mock.calls[0][0]).toContainEqual(expect.objectContaining({
    id: "voka-youtube-main",
    matches: ["https://www.youtube.com/*"],
    world: "MAIN",
    runAt: "document_start",
  }));

  config.denyList = ["www.youtube.com"];
  register.mockClear();
  await scheduleSiteSync();
  expect(register.mock.calls.flatMap(([scripts]) => scripts)).not.toContainEqual(
    expect.objectContaining({ id: "voka-youtube-main" }),
  );
});


it("removes remembered access and denies this host when all-sites permission remains", async () => {
  const { forgetSite } = await import("./sites");
  const remove = vi.fn(async () => true);
  (chrome.permissions as unknown as { remove: typeof remove }).remove = remove;
  config.siteScope = "all";
  await forgetSite("example.com");
  expect(config.rememberedSites).toEqual([]);
  expect(config.denyList).toContain("example.com");
  expect(remove).toHaveBeenCalledWith({ origins: ["*://example.com/*"] });
  expect(await shouldAutoRun("https://example.com/")).toBe(false);
});

async function forgetRememberedYouTube() {
  const { forgetSite } = await import("./sites");
  await forgetSite("www.youtube.com");
}
