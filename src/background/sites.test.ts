import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { rememberSite, scheduleSiteSync, shouldAutoRun } from "./sites";

let config: Record<string, unknown>;
let granted: boolean;
let request: ReturnType<typeof vi.fn>;
let register: ReturnType<typeof vi.fn>;
beforeEach(() => {
  config = { siteScope: "remembered", rememberedSites: ["example.com"], denyList: ["mail.google.com"] };
  granted = true;
  request = vi.fn(async () => granted);
  register = vi.fn(async () => {});
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
      getRegisteredContentScripts: vi.fn(async () => []),
      registerContentScripts: register,
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
